import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { ensureRuntimeAuthTokenFile } from "./auth-token";
import { hostedProviderEnvironment } from "./hosted-provider-resolution";
import { buildHermesManagedChannelsPatch } from "./managed-channel-reconciliation";
import { hostedChannelProjection, hostedWhatsAppAuthCredentials } from "./manifest-channels";
import type { LiveSyncAgent, RuntimeManifest } from "./manifest-contract";
import { hostedMcpIntent } from "./manifest-mcp";
import { openClawGatewayHostedPatch } from "./manifest-providers";
import {
	managedLocaleBlock,
	mergeRuntimeSecretEnv,
	resolvedRuntimeSettings,
} from "./manifest-runtime-config";
import { makeManagedSecretRoot, scopedSecretValues } from "./manifest-secrets";
import type { RuntimePaths } from "./paths";
import { runtimeNameSchema, runtimeServiceNameSchema } from "./run-config";
import { runtimeProgramRevision } from "./runtime-impact-revision";

export function removeStaleRuntimeRunConfigs(
	writtenRunConfigIds: Set<string>,
	paths: RuntimePaths,
): void {
	if (!existsSync(paths.runConfigRoot)) return;
	for (const entry of readdirSync(paths.runConfigRoot)) {
		if (!entry.endsWith(".json")) continue;
		const id = entry.slice(0, -".json".length);
		if (!runtimeRunConfigIdIsValid(id)) continue;
		if (!writtenRunConfigIds.has(id)) {
			rmSync(join(paths.runConfigRoot, entry), { force: true });
		}
	}
}
function runtimeRunConfigIdIsValid(id: string): boolean {
	const [runtime, service, ...rest] = id.split("+");
	if (rest.length > 0) return false;
	if (!runtimeNameSchema.safeParse(runtime).success) return false;
	if (service === undefined) return true;
	return runtimeServiceNameSchema.safeParse(service).success;
}
export const MANAGED_LIVE_SYNC_AGENTS = ["openclaw", "hermes", "codex"] as const;
function desiredLiveSyncAgents(manifest: RuntimeManifest): LiveSyncAgent[] {
	if (manifest.liveSync?.enabled === false) return [];
	const agents = manifest.liveSync?.agents ?? [];
	const byAgent = new Map<LiveSyncAgent["agentType"], LiveSyncAgent>();
	for (const agent of agents) byAgent.set(agent.agentType, agent);
	return [...byAgent.values()].sort((a, b) => a.agentType.localeCompare(b.agentType));
}
export function writeLiveSyncEnvironmentFiles(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
): string[] {
	const agents = desiredLiveSyncAgents(manifest);
	const desiredTypes = new Set(agents.map((agent) => agent.agentType));
	const envDir = paths.localEnvironments;
	mkdirSync(envDir, { recursive: true });
	for (const agentType of MANAGED_LIVE_SYNC_AGENTS) {
		if (!desiredTypes.has(agentType)) {
			rmSync(join(envDir, `${agentType}.json`), { force: true });
		}
	}
	const outputs: string[] = [];
	for (const agent of agents) {
		const path = join(envDir, `${agent.agentType}.json`);
		writePrivateFileAtomic(
			path,
			`${JSON.stringify(
				{
					id: agent.environmentId,
					agentType: agent.agentType,
					managedBy: "clawdi runtime init",
					deploymentId: manifest.deploymentId,
					instanceId: manifest.instanceId,
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600, dirMode: 0o700 },
		);
		outputs.push(path);
	}
	return outputs;
}
export function writeDaemonAuthToken(
	paths: RuntimePaths,
	secretValues: Record<string, string> | undefined,
): string | null {
	const path = ensureRuntimeAuthTokenFile(paths, secretValues ?? {});
	if (!path) return null;
	makeManagedSecretRoot(dirname(path));
	return path;
}
// Fields a hosted runtime reads from its config files without a process restart:
// Hermes resolves model and provider config from config.yaml on every turn, and
// the OpenClaw gateway watcher hot-applies external config writes (restarting
// itself for any path that needs it). Values delivered through the unit
// environment still change the unit fingerprint and restart the runtime.
const HOT_RUNTIME_ENTRY_FIELDS = new Set(["primary_model", "provider_ids", "providerMode"]);
function runtimeProgramEntry(
	desiredRuntime: RuntimeManifest["runtimes"][string] | undefined,
): Record<string, unknown> | undefined {
	if (!desiredRuntime) return undefined;
	return Object.fromEntries(
		Object.entries(desiredRuntime).filter(([field]) => !HOT_RUNTIME_ENTRY_FIELDS.has(field)),
	);
}
function hermesChannelProjection(
	manifest: RuntimeManifest,
	desiredRuntime: RuntimeManifest["runtimes"][string] | undefined,
	hermesWhatsAppAuthDir: string | null,
): Record<string, unknown> | null {
	const channels = hostedChannelProjection(manifest);
	if (!channels || !desiredRuntime?.enabled) return null;
	return buildHermesManagedChannelsPatch(channels, hermesWhatsAppAuthDir);
}
export function runtimeProgramRevisionForManifest(
	manifest: RuntimeManifest,
	runtime: string,
	secretValues: Record<string, string> | undefined,
	providerProjectionRevision: string | null,
	hermesWhatsAppAuthDir: string | null,
	openClawOwnerBrowserBootstrapSupported: boolean,
): string {
	const desiredRuntime = manifest.runtimes[runtime];
	const providerEnvironment = desiredRuntime
		? hostedProviderEnvironment(manifest, runtime)
		: { placeholderEnv: {}, secretEnv: {} };
	const runtimeSettings = desiredRuntime
		? resolvedRuntimeSettings(
				manifest,
				runtime,
				desiredRuntime.run,
				providerEnvironment.placeholderEnv,
			)
		: undefined;
	const runtimeSecretRefs = desiredRuntime
		? [
				...Object.values(
					mergeRuntimeSecretEnv(runtime, runtimeSettings, providerEnvironment.secretEnv),
				),
				...hostedWhatsAppAuthCredentials(manifest)
					.filter((credential) => credential.target === runtime)
					.map((credential) => credential.credsJsonSecretRef),
			]
		: [];
	if (runtime !== "openclaw" && runtime !== "hermes") {
		return runtimeProgramRevision({
			renderedProjection: {
				channels: null,
				gateway: null,
				locale: manifest.locale?.timezone ?? null,
				mcp: null,
				provider: providerProjectionRevision,
			},
			desiredRuntime,
			secretValues: scopedSecretValues(secretValues, runtimeSecretRefs),
		});
	}
	const gatewayPatch =
		runtime === "openclaw"
			? openClawGatewayHostedPatch(manifest, secretValues, openClawOwnerBrowserBootstrapSupported)
			: null;
	return runtimeProgramRevision({
		renderedProjection:
			runtime === "openclaw"
				? {
						// Only gateway listener/auth settings need a restart; OpenClaw applies
						// channels, MCP, provider models and agent defaults from its watcher.
						channels: null,
						gateway: gatewayPatch?.gateway ?? null,
						locale: null,
						mcp: null,
						provider: null,
					}
				: {
						// Hermes builds platform adapters, MCP server connections and its
						// timezone at startup, so those projections still restart it.
						channels: hermesChannelProjection(manifest, desiredRuntime, hermesWhatsAppAuthDir),
						gateway: null,
						locale: manifest.locale ? managedLocaleBlock(manifest.locale) : null,
						mcp: hostedMcpIntent(manifest),
						provider: null,
					},
		desiredRuntime: runtimeProgramEntry(desiredRuntime),
		secretValues: scopedSecretValues(secretValues, runtimeSecretRefs),
	});
}
