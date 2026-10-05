import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_AI_PROVIDER_RUNTIME_ENV } from "@clawdi/shared";
import { z } from "zod";
import { applyEgressTransparentRuntimeEnv, MANAGED_EGRESS_PLACEHOLDER_VALUE } from "./egress-env";
import { isPlainRecord } from "./manifest-shared";
import type { RuntimePaths } from "./paths";
import { runtimeImpactRevision } from "./runtime-impact-revision";
import {
	OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS,
	systemdDropInFilePath,
	systemdEnvironmentFilePath,
	systemdUnitFileName,
} from "./runtime-systemd-reconciliation";
import { writeRuntimePlatformFileAtomic } from "./state";

/**
 * Experimental, default-off fast first apply for OpenClaw. A pool instance warms
 * the official gateway before any tenant exists; the first tenant convergence
 * then adopts that running process instead of restarting it, and OpenClaw's
 * config watcher applies the tenant config (token, origins, providers, agents).
 */
export const OPENCLAW_HOT_APPLY_ENV = "CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY";

export function openClawHotApplyEnabled(): boolean {
	return process.env[OPENCLAW_HOT_APPLY_ENV] === "1";
}

const MARKER_SCHEMA = z
	.object({
		schemaVersion: z.literal("clawdi.openclawWarmGateway.v1"),
		identity: z.string().regex(/^[a-f0-9]{32}$/),
	})
	.strict();

const DIGEST_LINE = /^CLAWDI_MANAGED_CONTENT_DIGEST=.*$\n?/m;

function openClawGatewayProgramName(): string {
	const descriptor = OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
		(candidate) => candidate.runtime === "openclaw",
	);
	if (!descriptor) throw new Error("OpenClaw official service descriptor is missing");
	return descriptor.programName;
}

function markerPath(paths: RuntimePaths): string {
	return join(paths.statusRoot, "openclaw-warm-gateway.json");
}

/**
 * Gateway environment of a tenant whose only provider is Clawdi-managed behind
 * transparent egress: the key is the egress placeholder and the CA paths are
 * fixed, so it carries no tenant value. Any other tenant environment differs and
 * is not adopted.
 */
export function warmOpenClawGatewayEnvironment(paths: RuntimePaths): Record<string, string> {
	const env: NodeJS.ProcessEnv = {
		[MANAGED_AI_PROVIDER_RUNTIME_ENV]: MANAGED_EGRESS_PLACEHOLDER_VALUE,
	};
	applyEgressTransparentRuntimeEnv(env, { caFile: paths.egressSystemCaFile });
	return Object.fromEntries(
		Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

/** Gateway settings OpenClaw applies only by restarting, minus the hot hosted fields. */
function gatewayRestartSettings(config: unknown): unknown {
	if (!isPlainRecord(config) || !isPlainRecord(config.gateway)) return null;
	const gateway = structuredClone(config.gateway);
	delete gateway.trustedProxies;
	// A token change hot-applies while the auth mode stays the same.
	if (isPlainRecord(gateway.auth)) delete gateway.auth.token;
	if (isPlainRecord(gateway.controlUi)) delete gateway.controlUi.allowedOrigins;
	return gateway;
}

/**
 * Everything the running gateway process was started from, except the content
 * digest: unit, drop-in, environment, egress CA bundle and restart-only gateway
 * settings. Equal identities mean a restart would start an identical process.
 */
function warmOpenClawGatewayIdentity(paths: RuntimePaths): string | null {
	const name = openClawGatewayProgramName();
	try {
		const read = (path: string) => readFileSync(path, "utf8");
		return runtimeImpactRevision({
			unit: read(join(paths.systemdUserRoot, systemdUnitFileName(name))),
			dropIn: read(systemdDropInFilePath(paths, name)),
			environment: read(systemdEnvironmentFilePath(paths, name)).replace(DIGEST_LINE, ""),
			egressCaBundle: read(paths.egressSystemCaFile),
			gateway: gatewayRestartSettings(
				JSON.parse(read(join(paths.userHome, ".openclaw", "openclaw.json"))) as unknown,
			),
		});
	} catch {
		return null;
	}
}

export function recordWarmOpenClawGateway(paths: RuntimePaths): void {
	const identity = warmOpenClawGatewayIdentity(paths);
	if (!identity) throw new Error("warm OpenClaw gateway identity is unavailable");
	writeRuntimePlatformFileAtomic(
		paths,
		markerPath(paths),
		`${JSON.stringify({ schemaVersion: "clawdi.openclawWarmGateway.v1", identity })}\n`,
		{ mode: 0o600 },
	);
}

/** The warm gateway unit when its running process already matches this apply. */
export function adoptableWarmOpenClawGatewayUnits(paths: RuntimePaths): string[] {
	if (!openClawHotApplyEnabled() || paths.mode !== "hosted") return [];
	const path = markerPath(paths);
	let marker: z.infer<typeof MARKER_SCHEMA>;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return [];
		marker = MARKER_SCHEMA.parse(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return [];
	}
	return warmOpenClawGatewayIdentity(paths) === marker.identity
		? [systemdUnitFileName(openClawGatewayProgramName())]
		: [];
}

/** Adoption is single-use: later applies restart on any digest change as usual. */
export function consumeWarmOpenClawGateway(paths: RuntimePaths): void {
	rmSync(markerPath(paths), { force: true });
}
