import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { components } from "@clawdi/shared/api";
import JSON5 from "json5";
import { z } from "zod";
import { log } from "../serve/log";
import {
	type RuntimeAppliedState,
	readRuntimeAppliedState,
	runtimeContentSha256,
} from "./applied-state";
import type { RuntimeManifestLoad } from "./manifest-source";
import type { RuntimePaths } from "./paths";
import { readRuntimeServiceRunConfig, runtimeRunConfigPath } from "./run-config";
import { runtimeSecretValue } from "./secret-values";
import { writeRuntimePlatformFileAtomic } from "./state";
import { readSystemdComponentFingerprint } from "./systemd-transaction";

type Activation = Omit<components["schemas"]["HostedRuntimeObservedComponentV1"], "status">;
const evidenceSchema = z
	.object({
		schemaVersion: z.literal(1),
		appliedStateRevision: z.string().regex(/^[a-f0-9]{64}$/),
		entries: z
			.array(
				z
					.object({
						component: z.enum(["files", "hermes-ui", "openclaw-ui"]),
						configRevision: z.string().regex(/^[a-f0-9]{64}$/),
						accessRevision: z.string().regex(/^[a-f0-9]{64}$/),
						invocationId: z.string().regex(/^[a-f0-9]{32}$/),
					})
					.strict(),
			)
			.max(3),
	})
	.strict();

function evidencePath(paths: RuntimePaths): string {
	return join(dirname(paths.appliedState), "component-activations.json");
}

export function persistComponentActivations(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	readServiceState: ReadComponentServiceState,
): void {
	if (paths.mode !== "hosted") return;
	try {
		const applied = readRuntimeAppliedState(paths);
		if (!applied?.applyReceiptId || !applied.bootNonce) return;
		const evidence = {
			schemaVersion: 1,
			appliedStateRevision: runtimeContentSha256(applied),
			entries: captureComponentActivations(load, paths, applied.activated, readServiceState),
		};
		writeRuntimePlatformFileAtomic(
			paths,
			evidencePath(paths),
			`${JSON.stringify(evidenceSchema.parse(evidence))}\n`,
			{ mode: 0o600, dirMode: 0o755 },
		);
	} catch {
		log.warn("runtime.component_proof_unavailable", {
			message:
				"Component activation proof could not be persisted; complete-runtime admission remains required.",
		});
	}
}

function readComponentActivations(
	paths: RuntimePaths,
	applied: RuntimeAppliedState,
): Activation[] | undefined {
	try {
		const stat = lstatSync(evidencePath(paths));
		if (!stat.isFile() || stat.size > 16 * 1024) return undefined;
		const parsed = evidenceSchema.parse(JSON.parse(readFileSync(evidencePath(paths), "utf8")));
		if (new Set(parsed.entries.map((entry) => entry.component)).size !== parsed.entries.length)
			return undefined;
		return parsed.appliedStateRevision === runtimeContentSha256(applied)
			? parsed.entries
			: undefined;
	} catch {
		return undefined;
	}
}
type Component = Activation["component"];
export interface ComponentServiceState {
	invocationId: string;
	configurationRevision: string;
}
export type ReadComponentServiceState = (
	scope: "system" | "user",
	unit: string,
) => ComponentServiceState | null;
const services = {
	files: { scope: "system", unit: "clawdi-files.service" },
	"hermes-ui": { scope: "user", unit: "clawdi-hermes-dashboard.service" },
	"openclaw-ui": { scope: "user", unit: "openclaw-gateway.service" },
} as const;

function hasIncludes(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	return Object.hasOwn(value, "$include") || Object.values(value).some(hasIncludes);
}

function configRevision(
	component: Component,
	paths: RuntimePaths,
	expectedUnit: string | undefined,
): string | null {
	try {
		const service = services[component];
		const unit = readSystemdComponentFingerprint(paths, service.scope, service.unit);
		if (!unit || unit !== expectedUnit) return null;
		let files: string[];
		if (component === "files") files = [paths.fileBrowserConfig];
		else if (component === "openclaw-ui")
			files = [join(paths.userHome, ".openclaw", "openclaw.json")];
		else {
			const run = readRuntimeServiceRunConfig("hermes", "dashboard", paths);
			if (run.status !== "ok") return null;
			files = [runtimeRunConfigPath("hermes", paths, "dashboard")];
			if (run.config.secretFilePath) files.push(run.config.secretFilePath);
		}
		const contents = files.map((path) => {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.size > 1024 * 1024)
				throw new Error("Component config unavailable");
			return readFileSync(path, "utf8");
		});
		// Included native configuration has a separate mutation authority. Until its
		// resolved dependency set is recorded, retain aggregate-only admission.
		if (component === "openclaw-ui") {
			const config: unknown = JSON5.parse(contents[0] ?? "null");
			if (hasIncludes(config) || !config || typeof config !== "object" || !("gateway" in config))
				return null;
			const gateway = config.gateway;
			if (!gateway || typeof gateway !== "object" || ("port" in gateway && gateway.port !== 18789))
				return null;
		}
		return runtimeContentSha256([unit, ...contents]);
	} catch {
		return null;
	}
}

export function captureComponentActivations(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	activated: Record<string, string>,
	readServiceState: ReadComponentServiceState,
): Activation[] {
	const manifest = load.manifest;
	const secrets = load.secretValues ?? {};
	const revisions: Partial<Record<Component, string>> = {};
	if (manifest.companions?.filebrowser) {
		const auth = manifest.companions.filebrowser.auth;
		revisions.files = runtimeContentSha256(["files", auth.accessRevision, auth.secret]);
	}
	const openclaw = manifest.openclawGatewayAuth;
	if (openclaw) {
		const token = runtimeSecretValue(secrets, openclaw.tokenRef);
		if (token) revisions["openclaw-ui"] = runtimeContentSha256(["openclaw-ui", token]);
	}
	const hermes = manifest.hermesDashboardAuth;
	if (hermes) {
		const password = runtimeSecretValue(secrets, hermes.passwordSecretRef);
		const session = runtimeSecretValue(secrets, hermes.sessionSecretRef);
		if (password && session)
			revisions["hermes-ui"] = runtimeContentSha256([
				"hermes-ui",
				hermes.username,
				password,
				session,
			]);
	}
	const result: Activation[] = [];
	for (const component of Object.keys(services) as Component[]) {
		const service = services[component];
		const accessRevision = revisions[component];
		if (!accessRevision || !activated[service.unit]) continue;
		const manager = readServiceState(service.scope, service.unit);
		const config = configRevision(component, paths, activated[service.unit]);
		const after = readServiceState(service.scope, service.unit);
		if (
			manager &&
			after &&
			config &&
			manager.invocationId === after.invocationId &&
			manager.configurationRevision === after.configurationRevision
		) {
			result.push({
				component,
				configRevision: runtimeContentSha256([config, manager.configurationRevision]),
				accessRevision,
				invocationId: manager.invocationId,
			});
		}
	}
	return result;
}

export async function observeComponents(
	paths: RuntimePaths,
	applied: RuntimeAppliedState,
	readServiceState: ReadComponentServiceState,
	probe: (component: Component) => Promise<boolean>,
): Promise<components["schemas"]["HostedRuntimeObservedComponentsV1"] | undefined> {
	if (!applied.applyReceiptId || !applied.bootNonce) return undefined;
	const activations = readComponentActivations(paths, applied);
	if (!activations) return undefined;
	const entries = await Promise.all(
		activations.map(async (activation) => {
			let invocationId = activation.invocationId;
			let status: "ok" | "unknown" = "unknown";
			try {
				const service = services[activation.component];
				const current = readServiceState(service.scope, service.unit);
				invocationId = current?.invocationId ?? invocationId;
				const configurationMatches = (manager: ComponentServiceState) => {
					const config = configRevision(
						activation.component,
						paths,
						applied.activated[service.unit],
					);
					return (
						config !== null &&
						runtimeContentSha256([config, manager.configurationRevision]) ===
							activation.configRevision
					);
				};
				if (current && configurationMatches(current) && (await probe(activation.component))) {
					const after = readServiceState(service.scope, service.unit);
					if (after?.invocationId === current.invocationId && configurationMatches(after))
						status = "ok";
				}
			} catch {
				// An unavailable component must not discard its peers' observations.
			}
			return { ...activation, invocationId, status };
		}),
	);
	const current = readRuntimeAppliedState(paths);
	if (!current || runtimeContentSha256(current) !== runtimeContentSha256(applied)) return undefined;
	return { schemaVersion: 1, entries };
}
