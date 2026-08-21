import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { runtimeContentSha256 } from "./applied-state";
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
	liveSyncEnvironmentIndexSchema,
	managedLocaleBlock,
	mergeRuntimeSecretEnv,
	resolvedRuntimeSettings,
} from "./manifest-runtime-config";
import { makeManagedSecretRoot, scopedSecretValues } from "./manifest-secrets";
import { writeRuntimePrivateFileAtomic } from "./manifest-shared";
import type { RuntimePaths } from "./paths";
import { type RuntimeName, runtimeNameSchema, runtimeServiceNameSchema } from "./run-config";
import { runtimeProgramRevision } from "./runtime-impact-revision";
import { makeRuntimeUserOwned, withRuntimeUserFileAccess } from "./runtime-user-command";

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
	const staleCandidates = new Set<RuntimeName>([
		...readLiveSyncEnvironmentIndex(paths),
		...MANAGED_LIVE_SYNC_AGENTS,
	] as RuntimeName[]);
	const written = withRuntimeUserFileAccess(() => {
		const envDir = paths.localEnvironments;
		mkdirSync(envDir, { recursive: true });
		makeRuntimeUserOwned(envDir);
		for (const agentType of staleCandidates) {
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
			makeRuntimeUserOwned(path);
			outputs.push(path);
		}
		return outputs;
	});
	writeLiveSyncEnvironmentIndex(desiredTypes, paths);
	return written;
}
// SUNSET: Remove after every fleet host has migrated to the dedicated hosted CLAWDI_HOME.
export function removeLegacyTenantClawdiState(paths: RuntimePaths): void {
	const legacyRoot = join(paths.userHome, ".clawdi");
	if (resolve(legacyRoot) === resolve(paths.clawdiHome)) return;
	let root: ReturnType<typeof lstatSync>;
	try {
		root = lstatSync(legacyRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!root.isDirectory() || root.isSymbolicLink()) return;
	const environments = join(legacyRoot, "environments");
	let directory: ReturnType<typeof lstatSync>;
	try {
		directory = lstatSync(environments);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!directory.isDirectory() || directory.isSymbolicLink()) return;
	let removedManagedFile = false;
	for (const entry of readdirSync(environments)) {
		if (!entry.endsWith(".json")) continue;
		const path = join(environments, entry);
		try {
			const node = lstatSync(path);
			if (!node.isFile() || node.isSymbolicLink()) continue;
			let value: unknown;
			try {
				value = JSON.parse(readFileSync(path, "utf8")) as unknown;
			} catch {
				continue;
			}
			if (
				typeof value !== "object" ||
				value === null ||
				Array.isArray(value) ||
				(value as Record<string, unknown>).managedBy !== "clawdi runtime init"
			) {
				continue;
			}
			rmSync(path);
			removedManagedFile = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (!removedManagedFile) return;
	removeEmptyLegacyDirectory(environments);
	removeEmptyLegacyDirectory(legacyRoot);
}
function removeEmptyLegacyDirectory(path: string): void {
	try {
		rmdirSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
	}
}
function liveSyncEnvironmentIndexPath(paths: RuntimePaths): string {
	return paths.liveSyncEnvironmentIndex;
}
function readLiveSyncEnvironmentIndex(paths: RuntimePaths): RuntimeName[] {
	const path = liveSyncEnvironmentIndexPath(paths);
	if (!existsSync(path)) return [];
	try {
		const parsed = liveSyncEnvironmentIndexSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
		return parsed.agentTypes;
	} catch {
		return [];
	}
}
function writeLiveSyncEnvironmentIndex(agentTypes: Set<RuntimeName>, paths: RuntimePaths): void {
	writeRuntimePrivateFileAtomic(
		paths,
		liveSyncEnvironmentIndexPath(paths),
		`${JSON.stringify(
			{
				schemaVersion: "clawdi.liveSyncEnvironments.v1",
				agentTypes: [...agentTypes].sort(),
			},
			null,
			2,
		)}\n`,
		{
			mode: 0o644,
			// The parent is the configuration platform root; its mode is owned
			// by the systemd ConfigurationDirectory directive, never by this
			// writer.
		},
	);
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
export function daemonAuthTokenRevision(token: string): string {
	return runtimeContentSha256({
		schemaVersion: "clawdi.daemonAuthTokenRevision.v1",
		token,
	});
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
					.filter(
						(credential) =>
							credential.target === runtime ||
							(runtime === "openclaw" && credential.target === "legacy"),
					)
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
