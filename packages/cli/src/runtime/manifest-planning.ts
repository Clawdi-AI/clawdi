import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildAgentTargetProjection } from "../lib/ai-provider-projection";
import {
	type FileBrowserCompanionInstallOptions,
	fileBrowserCompanionMutationPlan,
	fileBrowserCompanionProgram,
} from "./file-browser-companion";
import type { PreparedHostedAgentPlugins } from "./hosted-agent-plugin-package";
import {
	type HostedAgentPluginCommandRunner,
	type HostedAgentPluginCommands,
	type HostedAgentPluginTransaction,
	prepareHostedAgentPluginTransaction,
	proveHostedAgentPluginCapabilities,
} from "./hosted-agent-plugin-runtime";
import { hostedBundledSkillIds } from "./hosted-bundled-skill";
import type { HostedHermesSkillExactSourceDriver } from "./hosted-hermes-skill";
import { createOpenClawHostedContext, type OpenClawHostedContext } from "./hosted-openclaw-context";
import type { HostedOpenClawSkillDriver } from "./hosted-openclaw-skill";
import {
	agentTargetProjectionInput,
	hostedAiProviderCatalog,
	hostedProviderEnvironment,
} from "./hosted-provider-resolution";
import type { HostedRuntimeContractOptions } from "./hosted-runtime-contract";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import { runtimeInstallReceiptsPath } from "./install-receipts";
import {
	captureRuntimeLiveSnapshot,
	type RuntimeLiveSnapshot,
	type RuntimeManagedMutationPlan,
	restoreRuntimeLiveSnapshot,
	runtimeRootLiveMutationDirectories,
	runtimeRootLiveMutationTargets,
} from "./live-state-snapshot";
import {
	type ManagedBaileysRuntime,
	managedBaileysCompatMutationTargets,
	managedBaileysCompatSnapshotRuntimes,
} from "./managed-baileys-compat";
import { buildHermesManagedChannelsPatch } from "./managed-channel-reconciliation";
import { ManagedSkillResourceError, managedSkillReceiptPath } from "./managed-skill-delivery";
import { managedSkillReservations } from "./managed-skill-reservation";
import {
	hostedChannelCredentialsDeclared,
	hostedChannelProjection,
	hostedWhatsAppAuthCredentials,
	managedWhatsAppAuthRoot,
	OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS,
	openClawManagedChannelsPatch,
	readManagedWhatsAppAuthMarker,
	validateHostedChannelCredentialsPlan,
} from "./manifest-channels";
import type { RuntimeManifest } from "./manifest-contract";
import {
	type RuntimeInstallObservation,
	runtimeAppRoot,
	runtimeCommandPath,
	runtimeInstallerMutationTargets,
} from "./manifest-install";
import { HOSTED_RUNTIME_TARGETS, validateHostedMcpProjectionPlan } from "./manifest-mcp";
import { hermesAuthPath } from "./manifest-oauth";
import {
	assertHostedProviderProjectionMode,
	buildOpenClawHostedProviderPatch,
	CODEX_MANAGED_PROVIDER_CONFIG_FILE,
	hostedCodexHome,
	hostedCodexManagedConfigToml,
	hostedCodexManagedProvider,
	legacyHermesModelProviderPluginDir,
	openClawGatewayHostedPatch,
} from "./manifest-providers";
import {
	managedLocaleBlock,
	mergeRuntimeSecretEnv,
	nextManagedLocaleFileContent,
	resolvedRuntimeServiceSettings,
	resolvedRuntimeSettings,
} from "./manifest-runtime-config";
import { MANAGED_LIVE_SYNC_AGENTS } from "./manifest-runtime-state";
import { scopedSecretValues } from "./manifest-secrets";
import {
	mutationAncestorMetadataTargets,
	type RuntimeConvergenceResult,
	type RuntimePrivateAppliedAuthority,
	type RuntimeSystemdApplyHooks,
	recordValue,
} from "./manifest-shared";
import type { RuntimeManifestLoad } from "./manifest-source";
import type { EnsureRuntimeMitmproxyOptions } from "./mitmproxy-fetch";
import { type RuntimePaths, runtimeSystemdPlatformEnclaves } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import {
	buildRuntimeRunConfig,
	isSupportedRuntimeName,
	type RuntimeRunConfig,
	runtimeNameSchema,
	runtimeServiceNameSchema,
} from "./run-config";
import {
	buildRuntimeSystemdUserProgram,
	planRuntimeSystemdUserMutations,
	type RuntimeEgressSystemdProgram,
	type RuntimeSystemdUserProgram,
} from "./runtime-systemd-reconciliation";
import {
	executableExists,
	type RuntimeUserOwnershipRule,
	runtimeUserExistingOwnership,
} from "./runtime-user-command";

export interface RuntimeConvergenceOptions {
	cacheLastGood?: boolean;
	commitAuthority?: (
		convergence: RuntimeConvergenceResult,
		authority: RuntimePrivateAppliedAuthority,
	) => void;
	egressEngineEnsureOptions?: EnsureRuntimeMitmproxyOptions;
	systemdApply?: RuntimeSystemdApplyHooks;
	executeOfficialServiceInstallers?: boolean;
	fileBrowserInstallOptions?: FileBrowserCompanionInstallOptions;
	fileBrowserReadinessProbe?: (url: string) => boolean;
	preparedHostedSourcedSkills?: ReadonlyMap<string, PreparedHostedSourcedSkill>;
	preparedHostedAgentPlugins?: PreparedHostedAgentPlugins;
	resourcePreparationFailures?: RuntimeResourcePreparationFailures;
	hostedAgentPluginCommandRunner?: HostedAgentPluginCommandRunner;
	hostedHermesSkillExactSourceDriver?: HostedHermesSkillExactSourceDriver;
	hostedOpenClawSkillDriver?: HostedOpenClawSkillDriver;
	hostedRuntimeContract?: HostedRuntimeContractOptions;
}

export interface RuntimeResourcePreparationFailures {
	agentPlugins?: {
		error: string;
		installationNames: readonly string[];
	};
	sourcedSkills?: string;
}
export function planHostedAgentPluginConvergence(input: {
	prepared: PreparedHostedAgentPlugins;
	home: string;
	commands: HostedAgentPluginCommands;
	runner?: HostedAgentPluginCommandRunner;
}): {
	transaction: HostedAgentPluginTransaction | null;
} {
	const proof = proveHostedAgentPluginCapabilities({
		prepared: input.prepared,
		commands: input.commands,
		...(input.runner ? { runner: input.runner } : {}),
	});
	return {
		transaction: prepareHostedAgentPluginTransaction({
			prepared: input.prepared,
			home: input.home,
			commands: input.commands,
			capabilityProof: proof,
			...(input.runner ? { runner: input.runner } : {}),
		}),
	};
}
export function runtimeWorkspaceRoot(manifest: RuntimeManifest, paths: RuntimePaths): string {
	return manifest.workspaceRoot ?? paths.workspaceRoot;
}
export function runtimeSecretValues(load: RuntimeManifestLoad): Record<string, string> | undefined {
	return load.secretValues && Object.keys(load.secretValues).length > 0
		? load.secretValues
		: undefined;
}
export function planRuntimeSystemdUserPrograms(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	workspaceRoot: string;
	generatedAt: string;
	secretValues: Record<string, string> | undefined;
	observations: Map<string, RuntimeInstallObservation>;
	egressProfileBundlePath: string | null;
	egress: RuntimeEgressSystemdProgram | null;
}): RuntimeSystemdUserProgram[] {
	const programs: RuntimeSystemdUserProgram[] = [];
	for (const [name, runtime] of Object.entries(input.manifest.runtimes).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const observation = input.observations.get(name);
		if (!observation) throw new Error(`runtime ${name} install observation is missing`);
		const resolved = resolveRuntimeRunConfigs({
			manifest: input.manifest,
			paths: input.paths,
			name,
			runtime,
			observation,
			workspaceRoot: input.workspaceRoot,
			generatedAt: input.generatedAt,
			secretValues: input.secretValues,
			egressProfileBundlePath: input.egressProfileBundlePath,
		});
		if (
			runtime.enabled &&
			(isSupportedRuntimeName(name) || Boolean(runtime.run?.command?.trim()))
		) {
			const program = buildRuntimeSystemdUserProgram({
				config: resolved.runtime,
				paths: input.paths,
				secretValues: input.secretValues,
				egress: input.egress,
			});
			if (program) programs.push(program);
		}
		for (const serviceRunConfig of resolved.services) {
			const program = buildRuntimeSystemdUserProgram({
				config: serviceRunConfig,
				paths: input.paths,
				secretValues: input.secretValues,
				egress: input.egress,
			});
			if (program) programs.push(program);
		}
	}
	const fileBrowserProgram = fileBrowserCompanionProgram(input.manifest, input.paths);
	if (fileBrowserProgram) programs.push(fileBrowserProgram);
	return programs;
}
interface ResolvedRuntimeRunConfigs {
	runtime: RuntimeRunConfig;
	services: RuntimeRunConfig[];
	secretEnv: Record<string, string>;
	secretFilePath: string | null;
}
export function resolveRuntimeRunConfigs(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	name: string;
	runtime: RuntimeManifest["runtimes"][string];
	observation: RuntimeInstallObservation;
	workspaceRoot: string;
	generatedAt: string;
	secretValues: Record<string, string> | undefined;
	egressProfileBundlePath: string | null;
}): ResolvedRuntimeRunConfigs {
	const runtimeName = runtimeNameSchema.parse(input.name);
	const providerEnvironment = input.runtime.enabled
		? hostedProviderEnvironment(input.manifest, input.name, { validateOverlap: true })
		: { placeholderEnv: {}, secretEnv: {} };
	const { placeholderEnv: providerPlaceholderEnv, secretEnv: providerSecretEnv } =
		providerEnvironment;
	const runtimeRunSettings = resolvedRuntimeSettings(
		runtimeName,
		input.runtime.run,
		providerPlaceholderEnv,
	);
	const secretEnv = input.runtime.enabled
		? mergeRuntimeSecretEnv(input.name, runtimeRunSettings, providerSecretEnv)
		: {};
	const secretFilePath = null;
	const runtime = buildRuntimeRunConfig({
		runtime: runtimeName,
		enabled: input.runtime.enabled,
		generatedAt: input.generatedAt,
		generation: input.manifest.generation,
		instanceId: input.manifest.instanceId,
		commandPath: input.observation.commandPath,
		appRoot: input.observation.appRoot,
		workspaceRoot: input.workspaceRoot,
		egressProfileBundlePath: input.egressProfileBundlePath,
		settings: runtimeRunSettings,
		secretFilePath,
		secretEnv,
	});
	const services = Object.entries(input.runtime.services ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([serviceName, serviceSettings]) => {
			const service = runtimeServiceNameSchema.parse(serviceName);
			const settings = resolvedRuntimeServiceSettings(
				input.manifest,
				runtimeName,
				service,
				serviceSettings,
				providerPlaceholderEnv,
			);
			return buildRuntimeRunConfig({
				runtime: runtimeName,
				service,
				enabled: input.runtime.enabled,
				generatedAt: input.generatedAt,
				generation: input.manifest.generation,
				instanceId: input.manifest.instanceId,
				commandPath: input.observation.commandPath,
				appRoot: input.observation.appRoot,
				workspaceRoot: input.workspaceRoot,
				settings,
				secretFilePath: null,
				secretEnv: input.runtime.enabled
					? mergeRuntimeSecretEnv(input.name, settings, providerSecretEnv, service)
					: {},
			});
		});
	return { runtime, services, secretEnv, secretFilePath };
}
export function runtimeConvergenceWithoutApply(input: {
	load: RuntimeManifestLoad;
	paths: RuntimePaths;
	workspaceRoot: string;
	enabledRuntimes: string[];
	installErrors: string[];
	projectedProviderIds: Record<string, string[]>;
	agentPluginFailedNames?: string[];
}): RuntimeConvergenceResult {
	const instanceRoot = join(input.paths.instanceRoot, input.load.manifest.instanceId);
	return {
		manifest: input.load.manifest,
		source: input.load.source,
		sourcePath: input.load.sourcePath,
		offline: input.load.offline,
		mode: input.load.offline ? "degraded-offline" : "normal",
		enabledRuntimes: input.enabledRuntimes,
		installErrors: input.installErrors,
		resourceProjectionErrors: [],
		projectedProviderIds: input.projectedProviderIds,
		agentPluginFailedNames: input.agentPluginFailedNames ?? [],
		outputs: {
			processManager: "systemd",
			workspaceRoot: input.workspaceRoot,
			managedConfig: input.paths.managedConfig,
			syncState: input.paths.syncState,
			instanceData: input.paths.instanceData,
			sensitiveInstanceData: input.paths.sensitiveInstanceData,
			manifestLastGood: null,
			appliedState: null,
			installInventory: [],
			projections: [],
			managedLocaleFiles: [],
			runConfigs: [],
			systemdSystemUnitRoot: input.paths.systemdSystemRoot,
			systemdSystemUnits: [],
			systemdUserUnitRoot: input.paths.systemdUserRoot,
			systemdUserUnits: [],
			egressProfileBundle: null,
			egressSecretFile: null,
			egressEngine: null,
			egressTransparentEnv: null,
			egressAddon: null,
			liveSyncEnvironments: [],
			daemonAuthTokenFile: null,
			bootFinished: join(instanceRoot, "boot-finished"),
		},
	};
}
export function validateRuntimeProjectionPlan(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	openClawWorkspaceRoot: string | null;
	secretValues: Record<string, string> | undefined;
	observations: Map<string, RuntimeInstallObservation>;
	previousProjectedProviderIds: Record<string, string[]>;
	hermesWhatsAppAuthDir: string | null;
	openClawOwnerBrowserBootstrapSupported: boolean;
}): void {
	const {
		manifest,
		paths,
		openClawWorkspaceRoot,
		secretValues,
		observations,
		previousProjectedProviderIds,
		hermesWhatsAppAuthDir,
		openClawOwnerBrowserBootstrapSupported,
	} = input;
	const home = hostedRuntimeProjectionHome(manifest, paths);
	const localeBlock = manifest.locale ? managedLocaleBlock(manifest.locale) : null;
	if (localeBlock) {
		for (const name of Object.keys(manifest.runtimes)) {
			if (manifest.runtimes[name]?.enabled !== true) continue;
			if (name === "openclaw") {
				if (!openClawWorkspaceRoot)
					throw new Error("OpenClaw official agent workspace is unavailable");
				nextManagedLocaleFileContent(join(openClawWorkspaceRoot, "SOUL.md"), localeBlock);
			}
			if (name === "hermes") {
				nextManagedLocaleFileContent(join(home, ".hermes", "SOUL.md"), localeBlock);
			}
		}
	}

	const codexProvider = hostedCodexManagedProvider(manifest);
	if (codexProvider) {
		hostedCodexManagedConfigToml(codexProvider);
	}

	for (const [name, runtime] of Object.entries(manifest.runtimes).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const observation = observations.get(name);
		if (!observation) throw new Error(`runtime ${name} install observation is missing`);
		const runtimeName = runtimeNameSchema.parse(name);
		const providerEnvironment = runtime.enabled
			? hostedProviderEnvironment(manifest, name, { validateOverlap: true })
			: { placeholderEnv: {}, secretEnv: {} };
		const { placeholderEnv: providerPlaceholderEnv, secretEnv: providerSecretEnv } =
			providerEnvironment;
		const runtimeSettings = resolvedRuntimeSettings(
			runtimeName,
			runtime.run,
			providerPlaceholderEnv,
		);
		const secretEnv = runtime.enabled
			? mergeRuntimeSecretEnv(name, runtimeSettings, providerSecretEnv)
			: {};
		scopedSecretValues(secretValues, Object.values(secretEnv));
		for (const [serviceName, serviceSettings] of Object.entries(runtime.services ?? {})) {
			const service = runtimeServiceNameSchema.parse(serviceName);
			const settings = resolvedRuntimeServiceSettings(
				manifest,
				runtimeName,
				service,
				serviceSettings,
				providerPlaceholderEnv,
			);
			mergeRuntimeSecretEnv(name, settings, providerSecretEnv, service);
		}

		const projectionInput = agentTargetProjectionInput(hostedAiProviderCatalog(manifest, name));
		assertHostedProviderProjectionMode(name, manifest, projectionInput);
		const configuredProjectionUnavailable =
			manifest.runtimes[name]?.providerMode === "configured" && !projectionInput;
		if (name === "openclaw") {
			if (projectionInput) {
				buildOpenClawHostedProviderPatch(
					projectionInput,
					previousProjectedProviderIds.openclaw ?? [],
				);
			} else if (!configuredProjectionUnavailable) {
				buildOpenClawHostedProviderPatch(null, previousProjectedProviderIds.openclaw ?? []);
			}
			JSON.stringify(
				openClawGatewayHostedPatch(manifest, secretValues, openClawOwnerBrowserBootstrapSupported),
			);
		}
		if (name === "hermes") {
			if (projectionInput) {
				const yamlProjection = buildAgentTargetProjection(
					"hermes",
					projectionInput.catalog,
					projectionInput.primaryModel,
					{ freezeManagedModelCatalog: true },
				);
				const yamlFile = yamlProjection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
				if (!yamlFile)
					throw new Error("Hermes projection did not include a config merge YAML file.");
				if (!recordValue(parseYaml(yamlFile.content) as unknown)) {
					throw new Error("Hermes projection patch must be a YAML object.");
				}
			}
		}

		const channels = hostedChannelProjection(manifest);
		if (channels && name === "openclaw") JSON.stringify(openClawManagedChannelsPatch(channels));
		if (channels && name === "hermes" && runtime.enabled) {
			buildHermesManagedChannelsPatch(channels, hermesWhatsAppAuthDir);
		}
	}
	validateHostedMcpProjectionPlan(manifest, paths, observations);
	validateHostedChannelCredentialsPlan(manifest, secretValues, home);
}
export function excludeRuntimeSnapshotCoverage(
	plan: RuntimeManagedMutationPlan,
	coveragePlan: RuntimeManagedMutationPlan,
): RuntimeManagedMutationPlan {
	const contentRoots = coveragePlan.runtimeUserTargets.map((path) => resolve(path));
	const coveredByContentRoot = (path: string): boolean => {
		const candidate = resolve(path);
		return contentRoots.some((root) => {
			const relativePath = relative(root, candidate);
			return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
		});
	};
	const coveredMetadata = new Set(coveragePlan.metadataTargets.map((path) => resolve(path)));
	return {
		...plan,
		runtimeUserTargets: plan.runtimeUserTargets.filter((path) => !coveredByContentRoot(path)),
		runtimeUserSymlinkTargets: plan.runtimeUserSymlinkTargets.filter(
			(path) => !coveredByContentRoot(path),
		),
		metadataTargets: plan.metadataTargets.filter(
			(path) => !coveredByContentRoot(path) && !coveredMetadata.has(resolve(path)),
		),
	};
}
export function managedOpenClawPluginBootstrapMutationPlan(
	context: OpenClawHostedContext,
	paths: RuntimePaths,
): RuntimeManagedMutationPlan | null {
	if (!context.managedApiKeyProjection) return null;
	const targets = context.providerPlugin.mutationTargets;
	const runtimeUserTrustedRoots = [paths.userHome, paths.clawdiHome];
	return {
		rootTargets: [],
		trustedRootDirectories: [],
		runtimeUserTargets: targets,
		runtimeUserTrustedRoots,
		runtimeUserSymlinkTargets: [],
		metadataTargets: mutationAncestorMetadataTargets(targets, runtimeUserTrustedRoots),
	};
}
export interface RuntimeSnapshotRollbackScope {
	readonly start: number;
}

export interface RuntimeSnapshotCaptureScope extends RuntimeSnapshotRollbackScope {
	readonly snapshot: RuntimeLiveSnapshot;
}

export class RuntimeSnapshotRollbackStack {
	readonly #snapshots: Array<{ failure: string; snapshot: RuntimeLiveSnapshot }> = [];

	capture(failure: string, plan: RuntimeManagedMutationPlan): RuntimeLiveSnapshot {
		return this.captureScoped(failure, plan).snapshot;
	}

	scope(): RuntimeSnapshotRollbackScope {
		return { start: this.#snapshots.length };
	}

	captureScoped(failure: string, plan: RuntimeManagedMutationPlan): RuntimeSnapshotCaptureScope {
		const start = this.#snapshots.length;
		const snapshot = captureRuntimeLiveSnapshot(plan);
		this.#snapshots.push({ failure, snapshot });
		return { start, snapshot };
	}

	pop(scope?: RuntimeSnapshotRollbackScope): void {
		this.#snapshots.splice(scope?.start ?? 0);
	}

	restore(
		scope?: RuntimeSnapshotRollbackScope,
		formatFailure: (failure: string, error: unknown) => string = (failure, error) =>
			`${failure}: ${error instanceof Error ? error.message : String(error)}`,
	): string[] {
		const errors: string[] = [];
		for (const { failure, snapshot } of this.#snapshots.splice(scope?.start ?? 0).reverse()) {
			try {
				restoreRuntimeLiveSnapshot(snapshot);
			} catch (error) {
				errors.push(formatFailure(failure, error));
			}
		}
		return errors;
	}

	failure(error: unknown): unknown {
		const rollbackErrors = this.restore();
		if (rollbackErrors.length === 0) return error;
		return new Error(
			`${error instanceof Error ? error.message : String(error)}; ${rollbackErrors.join("; ")}`,
		);
	}
}
function hostedChannelCredentialMutationTargets(manifest: RuntimeManifest, home: string): string[] {
	const targets = new Set(
		hostedChannelCredentialsDeclared(manifest)
			? hostedWhatsAppAuthCredentials(manifest).map((entry) => entry.authDir)
			: [],
	);
	const root = managedWhatsAppAuthRoot(home, "openclaw");
	if (root && existsSync(root)) {
		for (const entry of readdirSync(root)) {
			const authDir = join(root, entry);
			if (readManagedWhatsAppAuthMarker(authDir)) targets.add(authDir);
		}
	}
	const hermesAuthDir = managedWhatsAppAuthRoot(home, "hermes");
	if (hermesAuthDir && readManagedWhatsAppAuthMarker(hermesAuthDir)?.target === "hermes") {
		targets.add(hermesAuthDir);
	}
	return [...targets];
}
export function managedWhatsAppCompatibilityRuntime(
	manifest: RuntimeManifest,
): ManagedBaileysRuntime | null {
	const runtimes = new Set<ManagedBaileysRuntime>();
	for (const credential of hostedWhatsAppAuthCredentials(manifest)) {
		runtimes.add(credential.target === "hermes" ? "hermes" : "openclaw");
	}
	if (runtimes.size > 1) {
		throw new Error("managed WhatsApp projection must target exactly one native runtime");
	}
	return runtimes.values().next().value ?? null;
}
export function runtimeUserMutationTargets(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	openClawWorkspaceRoot: string | null,
	observations: ReadonlyMap<string, Pick<RuntimeInstallObservation, "status">>,
	openClawContext: OpenClawHostedContext = createOpenClawHostedContext(
		manifest,
		hostedRuntimeProjectionHome(manifest, paths),
	),
): string[] {
	const home = openClawContext.home;
	const installerTargets = runtimeInstallerMutationTargets(manifest, home, observations);
	const managedWhatsAppRuntime = managedWhatsAppCompatibilityRuntime(manifest);
	const channels = hostedChannelProjection(manifest);
	const channelPluginTargets = channels
		? Object.keys(channels)
				.filter((channel) => Boolean(OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS[channel]))
				.map((channel) => join(home, ".openclaw", "extensions", channel))
		: [];
	const targets = new Set<string>([
		openClawContext.configPath,
		join(home, ".hermes", "config.yaml"),
		join(home, ".hermes", "SOUL.md"),
		hermesAuthPath(home),
		join(dirname(hermesAuthPath(home)), "auth.lock"),
		openClawContext.agentDirs.main,
		join(hostedCodexHome(home), CODEX_MANAGED_PROVIDER_CONFIG_FILE),
		legacyHermesModelProviderPluginDir(home),
		...installerTargets,
		...hostedChannelCredentialMutationTargets(manifest, home),
		...channelPluginTargets,
	]);
	if (openClawContext.managedApiKeyProjection) {
		for (const target of openClawContext.providerPlugin.mutationTargets) targets.add(target);
	}
	if (openClawWorkspaceRoot) targets.add(join(openClawWorkspaceRoot, "SOUL.md"));
	for (const name of HOSTED_RUNTIME_TARGETS) {
		if (manifest.runtimes[name]?.enabled !== true) continue;
		const commandPath = runtimeCommandPath(name, home);
		if (
			commandPath &&
			!installerTargets.some((target) => {
				const candidate = relative(resolve(target), resolve(commandPath));
				return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
			})
		) {
			// The command itself is an ownership mutation even when no runtime
			// install is pending. Root bootstrap images can otherwise leave a
			// private root-owned executable that root observes as present but the
			// official runtime user cannot execute. OpenClaw's official installer
			// writes the CLI under the selected prefix's bin directory:
			// https://github.com/openclaw/openclaw/blob/v2026.7.1/scripts/install-cli.sh#L1113-L1120
			targets.add(commandPath);
		}
	}
	const compatibilityRuntimes = managedBaileysCompatSnapshotRuntimes({
		desiredRuntime: managedWhatsAppRuntime,
		home,
		paths,
	});
	for (const runtime of compatibilityRuntimes) {
		const appRoot = runtimeAppRoot(runtime, home);
		if (!appRoot) continue;
		for (const target of managedBaileysCompatMutationTargets({ runtime, home, appRoot })) {
			// Cold installers and OpenClaw plugin reconciliation already snapshot
			// their complete roots. Do not add nested patch targets to that plan.
			if (
				[...installerTargets, ...channelPluginTargets].some(
					(root) => target === root || target.startsWith(`${root}/`),
				)
			) {
				continue;
			}
			targets.add(target);
		}
	}
	for (const agentType of MANAGED_LIVE_SYNC_AGENTS) {
		targets.add(join(paths.localEnvironments, `${agentType}.json`));
	}
	return [...targets].sort();
}
export function hostedSkillMutationTargets(
	manifest: RuntimeManifest,
	home: string,
	openClawWorkspaceRoot: string | null,
	managedResourceRoot: string,
	preparedSourcedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
	hermesDriver: HostedHermesSkillExactSourceDriver,
): { platformTargets: string[]; runtimeUserTargets: string[] } {
	const runtimeUserTargets = new Set<string>();
	const platformTargets = new Set<string>();
	const hermesSkillsRoot = join(home, ".hermes", "skills");
	const openClawSkillsRoot = openClawWorkspaceRoot ? join(openClawWorkspaceRoot, "skills") : null;
	const addSkillTargets = (runtime: "hermes" | "openclaw", skillsRoot: string, skillId: string) => {
		runtimeUserTargets.add(join(skillsRoot, skillId));
		platformTargets.add(managedSkillReceiptPath(managedResourceRoot, runtime, skillId));
	};
	let managesHermesSourcedSkill = false;
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		addSkillTargets("hermes", hermesSkillsRoot, skillId);
		if (openClawSkillsRoot) addSkillTargets("openclaw", openClawSkillsRoot, skillId);
		if ("source" in desired && manifest.runtimes.hermes?.enabled === true) {
			managesHermesSourcedSkill = true;
			const prepared = preparedSourcedSkills.get(skillId);
			if (prepared?.skillId === skillId) {
				let target: string | undefined;
				try {
					target = hermesDriver.target?.({ home, skill: prepared });
				} catch (error) {
					if (!(error instanceof ManagedSkillResourceError)) throw error;
				}
				if (target) runtimeUserTargets.add(target);
			}
		}
	}
	for (const skillId of hostedBundledSkillIds()) {
		addSkillTargets("hermes", hermesSkillsRoot, skillId);
		if (openClawSkillsRoot) addSkillTargets("openclaw", openClawSkillsRoot, skillId);
	}
	for (const reservation of managedSkillReservations("hosted-manifest")) {
		if (dirname(reservation.targetDir) === hermesSkillsRoot) {
			if (reservation.sourceIdentity) managesHermesSourcedSkill = true;
			runtimeUserTargets.add(reservation.targetDir);
			platformTargets.add(managedSkillReceiptPath(managedResourceRoot, "hermes", reservation.id));
		}
		if (openClawSkillsRoot && dirname(reservation.targetDir) === openClawSkillsRoot) {
			runtimeUserTargets.add(reservation.targetDir);
			platformTargets.add(managedSkillReceiptPath(managedResourceRoot, "openclaw", reservation.id));
		}
	}
	if (managesHermesSourcedSkill) runtimeUserTargets.add(join(hermesSkillsRoot, ".hub"));
	return {
		platformTargets: [...platformTargets].sort(),
		runtimeUserTargets: [...runtimeUserTargets].sort(),
	};
}
export function runtimeManagedMutationPlan(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	openClawWorkspaceRoot: string | null;
	openClawContext: OpenClawHostedContext;
	programs: RuntimeSystemdUserProgram[];
	observations: ReadonlyMap<string, RuntimeInstallObservation>;
}): {
	snapshot: RuntimeManagedMutationPlan;
	runtimeUserOwnership: RuntimeUserOwnershipRule[];
	staleOfficialUnits: string[];
	systemdUserUnits: string[];
	systemdDriftErrors: string[];
} {
	const rootTargets = new Set(runtimeRootLiveMutationTargets(input.manifest, input.paths));
	const fileBrowserMutation = fileBrowserCompanionMutationPlan(input.manifest, input.paths);
	for (const target of fileBrowserMutation.rootTargets) rootTargets.add(target);
	rootTargets.add(runtimeInstallReceiptsPath(input.paths));
	const rootMetadataTargets = new Set<string>();
	const egressPin = input.manifest.egressEngine;
	if (egressPin?.type === "mitmproxy") {
		const cacheDir = join(
			input.paths.egressEngineMaintainedRoot,
			egressPin.version,
			egressPin.sha256.toLowerCase(),
		);
		if (!executableExists(join(cacheDir, "mitmdump"))) rootTargets.add(cacheDir);
		rootMetadataTargets.add(dirname(input.paths.egressEngineMaintainedRoot));
		rootMetadataTargets.add(input.paths.egressEngineMaintainedRoot);
		rootMetadataTargets.add(join(input.paths.egressEngineMaintainedRoot, egressPin.version));
	}

	const systemd = planRuntimeSystemdUserMutations(input.programs, input.paths);
	for (const target of systemd.environmentTargets) rootTargets.add(target);
	const runtimeUserTargets = [
		...new Set([
			...runtimeUserMutationTargets(
				input.manifest,
				input.paths,
				input.openClawWorkspaceRoot,
				input.observations,
				input.openClawContext,
			),
			...systemd.targets,
		]),
	].sort();
	const rootTargetsList = [...rootTargets].sort();
	const projectionHome = hostedRuntimeProjectionHome(input.manifest, input.paths);
	const runtimeCommandTargets = HOSTED_RUNTIME_TARGETS.flatMap((name) => {
		if (input.manifest.runtimes[name]?.enabled !== true) return [];
		const commandPath = runtimeCommandPath(name, projectionHome);
		return commandPath ? [commandPath] : [];
	});
	const runtimeUserBoundaries = [input.paths.userHome, input.paths.clawdiHome];
	const runtimeUserMetadataTargets = [
		...new Set([
			...systemd.metadataTargets,
			input.paths.userHome,
			input.paths.clawdiHome,
			...mutationAncestorMetadataTargets(runtimeUserTargets, runtimeUserBoundaries),
		]),
	].sort();
	const platformEnclaveRoots = runtimeSystemdPlatformEnclaves(input.paths).map((enclave) =>
		resolve(enclave.path),
	);
	const runtimeUserOwnership = runtimeUserExistingOwnership([
		...runtimeUserTargets,
		...runtimeUserMetadataTargets,
		...runtimeCommandTargets,
	]).filter((rule) =>
		platformEnclaveRoots.every((root) => {
			const candidate = relative(root, rule.path);
			return candidate.startsWith("..") || isAbsolute(candidate);
		}),
	);
	return {
		snapshot: {
			rootTargets: rootTargetsList,
			trustedRootDirectories: [
				...runtimeRootLiveMutationDirectories(input.manifest, input.paths),
				...fileBrowserMutation.rootTrustedRoots,
			],
			runtimeUserTargets,
			runtimeUserTrustedRoots: runtimeUserBoundaries,
			runtimeUserSymlinkTargets: [
				...new Set([
					...systemd.symlinkTargets,
					...runtimeCommandTargets.filter((target) => runtimeUserTargets.includes(target)),
				]),
			].sort(),
			metadataTargets: [
				...new Set([
					...rootMetadataTargets,
					...systemd.metadataTargets,
					input.paths.configurationRoot,
					input.paths.serviceStateRoot,
					input.paths.cacheRoot,
					input.paths.runRoot,
					input.paths.systemdSystemRoot,
					...mutationAncestorMetadataTargets(rootTargetsList, [
						input.paths.configurationRoot,
						input.paths.serviceStateRoot,
						input.paths.cacheRoot,
						input.paths.runRoot,
						input.paths.systemdSystemRoot,
					]),
					...runtimeUserMetadataTargets,
				]),
			].sort(),
		},
		runtimeUserOwnership,
		staleOfficialUnits: systemd.staleOfficialUnits,
		systemdUserUnits: systemd.unitNames,
		systemdDriftErrors: systemd.driftErrors,
	};
}
