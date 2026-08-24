import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { ensureRuntimeAuthTokenFile } from "./auth-token";
import { hostedProviderEnvironment } from "./hosted-provider-resolution";
import { buildHermesManagedChannelsPatch } from "./managed-channel-reconciliation";
import {
	hostedChannelProjection,
	hostedWhatsAppAuthCredentials,
	openClawManagedChannelsPatch,
} from "./manifest-channels";
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
		? resolvedRuntimeSettings(runtime, desiredRuntime.run, providerEnvironment.placeholderEnv)
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
	const channels = hostedChannelProjection(manifest);
	const hostedTarget = runtime === "openclaw" || runtime === "hermes";
	let channelProjection: Record<string, unknown> | null = null;
	if (channels && runtime === "openclaw") {
		channelProjection = openClawManagedChannelsPatch(channels);
	} else if (channels && runtime === "hermes" && desiredRuntime?.enabled) {
		channelProjection = buildHermesManagedChannelsPatch(channels, hermesWhatsAppAuthDir);
	}
	return runtimeProgramRevision({
		renderedProjection: {
			channels: channelProjection,
			gateway:
				runtime === "openclaw"
					? openClawGatewayHostedPatch(
							manifest,
							secretValues,
							openClawOwnerBrowserBootstrapSupported,
						)
					: null,
			locale:
				manifest.locale && hostedTarget
					? managedLocaleBlock(manifest.locale)
					: (manifest.locale?.timezone ?? null),
			mcp: hostedTarget ? hostedMcpIntent(manifest) : null,
			provider: providerProjectionRevision,
		},
		desiredRuntime,
		secretValues: scopedSecretValues(secretValues, runtimeSecretRefs),
	});
}
