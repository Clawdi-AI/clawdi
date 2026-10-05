import { createHash } from "node:crypto";
import { chownSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readRuntimeAppliedState } from "./applied-state";
import { type EgressProfileBundle, egressProfileBundleSchema } from "./egress-profiles";
import { makeEgressIdentityPrivateDir } from "./manifest-egress";
import { egressSecretFilePath } from "./manifest-secrets";
import { readComponentServiceState } from "./observed";
import type { RuntimePaths } from "./paths";
import { runningAsRoot, runtimeEgressGid, runtimeEgressUid } from "./runtime-user-command";
import { writeRuntimePlatformFileAtomic } from "./state";

const UNIT = "clawdi-runtime-sidecar.service";
const DIGEST_LINE = /^CLAWDI_MANAGED_CONTENT_DIGEST=.*$\n?/m;
const warmMarkerSchema = z
	.object({
		schemaVersion: z.literal("clawdi.egressWarm.v1"),
		identity: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const secretSchema = z.record(z.string(), z.string());

export function egressSnapshotPaths(paths: RuntimePaths) {
	return {
		enabled: join(paths.statusRoot, "egress-snapshot-enabled"),
		warm: join(paths.statusRoot, "egress-warmed.json"),
		input: join(paths.egressRoot, "snapshot.json"),
		ack: join(paths.egressRoot, "snapshot-status", "ack"),
	};
}

function privateRootFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && stat.uid === 0 && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

export function egressSnapshotEnabled(paths: RuntimePaths): boolean {
	const path = egressSnapshotPaths(paths).enabled;
	return paths.mode === "hosted" && privateRootFile(path) && readFileSync(path, "utf8") === "v1\n";
}

/** One atomic file binds routing policy and its credentials. */
export function publishEgressSnapshot(
	paths: RuntimePaths,
	profiles: Pick<EgressProfileBundle, "schemaVersion" | "profiles">,
	secrets: Record<string, string>,
	claimed: boolean,
): void {
	const input = egressSnapshotPaths(paths).input;
	writeRuntimePlatformFileAtomic(
		paths,
		input,
		`${JSON.stringify({
			schemaVersion: "clawdi.egressSnapshot.v1",
			claimed,
			profiles,
			secrets,
		})}\n`,
		{ mode: 0o640, dirMode: 0o711 },
	);
	if (runningAsRoot()) chownSync(input, 0, runtimeEgressGid());
}

export function initializeAnonymousEgressSnapshot(paths: RuntimePaths): void {
	const files = egressSnapshotPaths(paths);
	if (existsSync(files.input)) {
		const anonymous = z
			.object({
				schemaVersion: z.literal("clawdi.egressSnapshot.v1"),
				claimed: z.literal(false),
				profiles: z
					.object({
						schemaVersion: z.literal("clawdi.egressProfiles.v1"),
						profiles: z.array(z.never()),
					})
					.strict(),
				secrets: z.object({}).strict(),
			})
			.strict();
		let valid = false;
		try {
			valid = anonymous.safeParse(JSON.parse(readFileSync(files.input, "utf8"))).success;
		} catch {
			// Do not expose any previous private snapshot content in a parse error.
		}
		if (!valid) throw new Error("runtime warm refuses non-anonymous egress state");
	}
	makeEgressIdentityPrivateDir(join(paths.egressRoot, "snapshot-status"));
	writeRuntimePlatformFileAtomic(paths, files.enabled, "v1\n", { mode: 0o600 });
	publishEgressSnapshot(
		paths,
		{ schemaVersion: "clawdi.egressProfiles.v1", profiles: [] },
		{},
		false,
	);
}

export function publishClaimedEgressSnapshot(paths: RuntimePaths): void {
	if (!egressSnapshotEnabled(paths)) return;
	const profiles = egressProfileBundleSchema.parse(
		JSON.parse(readFileSync(paths.egressProfileBundle, "utf8")),
	);
	const secretFile = egressSecretFilePath(paths);
	const secrets = existsSync(secretFile)
		? secretSchema.parse(JSON.parse(readFileSync(secretFile, "utf8")))
		: {};
	publishEgressSnapshot(paths, profiles, secrets, true);
}

function snapshotHash(paths: RuntimePaths): string {
	return createHash("sha256")
		.update(readFileSync(egressSnapshotPaths(paths).input))
		.digest("hex");
}

/** A live engine acknowledges the exact snapshot before warm adoption. */
export function waitForEgressSnapshot(paths: RuntimePaths, timeoutMs = 15_000): void {
	const expected = snapshotHash(paths);
	const ack = egressSnapshotPaths(paths).ack;
	const deadline = Date.now() + timeoutMs;
	const pause = new Int32Array(new SharedArrayBuffer(4));
	while (Date.now() < deadline) {
		try {
			const stat = lstatSync(ack);
			if (
				stat.isFile() &&
				stat.uid === runtimeEgressUid() &&
				(stat.mode & 0o077) === 0 &&
				readFileSync(ack, "utf8") === `${expected}\n` &&
				snapshotHash(paths) === expected
			)
				return;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		Atomics.wait(pause, 0, 0, 25);
	}
	throw new Error("egress engine did not acknowledge the candidate snapshot");
}

function warmEgressIdentity(paths: RuntimePaths): string | null {
	try {
		const manager = readComponentServiceState(paths, "system", UNIT);
		if (!manager) return null;
		return createHash("sha256")
			.update(
				JSON.stringify([
					manager,
					readFileSync(join(paths.systemdSystemRoot, UNIT), "utf8"),
					readFileSync(join(paths.systemdEnvRoot, `${UNIT}.env`), "utf8").replace(DIGEST_LINE, ""),
					readFileSync(paths.egressTransparentEnv, "utf8"),
					readFileSync(paths.egressSystemCaFile, "utf8"),
				]),
			)
			.digest("hex");
	} catch {
		return null;
	}
}

export function recordWarmEgress(paths: RuntimePaths): void {
	waitForEgressSnapshot(paths);
	const identity = warmEgressIdentity(paths);
	if (!identity) throw new Error("anonymous egress invocation is unavailable");
	writeRuntimePlatformFileAtomic(
		paths,
		egressSnapshotPaths(paths).warm,
		`${JSON.stringify({ schemaVersion: "clawdi.egressWarm.v1", identity })}\n`,
		{ mode: 0o600 },
	);
}

export function adoptableWarmEgress(paths: RuntimePaths): boolean {
	const path = egressSnapshotPaths(paths).warm;
	if (!egressSnapshotEnabled(paths) || readRuntimeAppliedState(paths) || !privateRootFile(path))
		return false;
	try {
		const marker = warmMarkerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		return marker.identity === warmEgressIdentity(paths);
	} catch {
		return false;
	}
}

export function consumeWarmEgress(paths: RuntimePaths): void {
	rmSync(egressSnapshotPaths(paths).warm, { force: true });
}
