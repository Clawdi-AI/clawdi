import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readRuntimeAppliedState } from "./applied-state";
import { removeHostedCliPathExposure } from "./cli-update";
import { buildEgressProfileBundle, hasEnabledEgressProfiles } from "./egress-profiles";
import {
	ensureFileBrowserCompanion,
	gcFileBrowserCompanionCandidates,
	probeFileBrowserReadiness,
} from "./file-browser-companion";
import {
	beginHermesConfigTransaction,
	commitHermesConfigTransaction,
	type HermesConfigTransaction,
} from "./hermes-config";
import { writeHostedAgentPluginReceipt } from "./hosted-agent-plugin-package";
import {
	type HostedAgentPluginTransaction,
	hostedAgentPluginCommands,
} from "./hosted-agent-plugin-runtime";
import {
	createOpenClawHostedContext,
	repairHostedOpenClawStartupMigrations,
	repairHostedOpenClawWorkspace,
	resolveHostedOpenClawWorkspace,
} from "./hosted-openclaw-context";
import { assertHostedRuntimeContract } from "./hosted-runtime-contract";
import { reconcileManagedBaileysCompatibility } from "./managed-baileys-compat";
import { managedHermesWhatsAppAuthDir } from "./managed-channel-reconciliation";
import {
	applyHostedChannelProjection,
	installHostedChannelProjectionDependencies,
	materializeHostedChannelCredentials,
} from "./manifest-channels";
import {
	AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR,
	hasUnsupportedAgentPluginInstallations,
} from "./manifest-contract";
import {
	clearEgressAddon,
	clearEgressProfileBundle,
	ensureRuntimeUserCliStateRoot,
	makeEgressIdentityPrivateDir,
	requireV2EgressEngineReady,
	writeEgressAddon,
	writeEgressProfileBundle,
	writeTransparentEgressEnvFile,
} from "./manifest-egress";
import {
	observeRuntimeInstall,
	planRuntimeInstallObservation,
	type RuntimeInstallObservation,
	runtimeCommandPath,
} from "./manifest-install";
import { applyHostedMcpProjections } from "./manifest-mcp";
import {
	discoverOpenClawManagedProviderAuthAgentDirs,
	ensureHostedOpenClawProviderAuthCapability,
	openClawSupportsOwnerBrowserBootstrap,
	reconcileHostedRuntimeOAuthCredentials,
} from "./manifest-oauth";
import {
	managedWhatsAppCompatibilityRuntime,
	planHostedAgentPluginConvergence,
	planRuntimeSystemdUserPrograms,
	type RuntimeConvergenceOptions,
	resolveRuntimeRunConfigs,
	runtimeConvergenceWithoutApply,
	runtimeSecretValues,
	runtimeWorkspaceRoot,
	validateRuntimeProjectionPlan,
} from "./manifest-planning";
import {
	applyHostedAiProviderProjection,
	applyHostedCodexManagedProviderProjection,
	ensureHostedCodexCli,
	previewHostedAiProviderProjectionRevision,
} from "./manifest-providers";
import { applyHostedRuntimeConfigProjection } from "./manifest-runtime-config";
import {
	removeStaleRuntimeRunConfigs,
	runtimeProgramRevisionForManifest,
	writeDaemonAuthToken,
	writeLiveSyncEnvironmentFiles,
} from "./manifest-runtime-state";
import {
	makeManagedSecretRoot,
	writeEgressSecretFile,
	writeLastGoodManifest,
} from "./manifest-secrets";
import type { RuntimeConvergenceResult } from "./manifest-shared";
import { reconcileHostedSkillProjection } from "./manifest-skills-apply";
import type { RuntimeManifestLoad } from "./manifest-source";
import { ensureRuntimeMitmproxy } from "./mitmproxy-fetch";
import { removeLegacyManagedOpenClawProviderPlugin } from "./openclaw-legacy-provider-plugin";
import type { RuntimePaths } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import { runtimeRunConfigId, writeRuntimeRunConfig } from "./run-config";
import { runtimeImpactRevision, runtimeProviderRevision } from "./runtime-impact-revision";
import {
	installOfficialRuntimeService,
	planOfficialRuntimeServices,
	prepareOfficialRuntimeServiceDependencies,
	type RuntimeSystemdStaleFilePlan,
	type RuntimeSystemdUserProgram,
	removeStaleRuntimeSystemdFiles,
	resolveRuntimeSystemdIdentity,
	runtimeSystemdCommonEnvironment,
	uninstallStaleOfficialRuntimeServices,
	validateRuntimeSystemdPlan,
	writeRuntimeSystemdState,
} from "./runtime-systemd-reconciliation";
import { executableExists, withRuntimeUserFileAccess } from "./runtime-user-command";
import { ensureRuntimePlatformDirectory } from "./state";

type RuntimeManifest = RuntimeManifestLoad["manifest"];
type RuntimeEntry = [string, RuntimeManifest["runtimes"][string]];

interface RuntimeConvergenceContext {
	load: RuntimeManifestLoad;
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	opts: RuntimeConvergenceOptions;
	secretValues: ReturnType<typeof runtimeSecretValues>;
	applyContext: NonNullable<RuntimeManifestLoad["applyContext"]>;
	hostedRuntimeContract: ReturnType<typeof assertHostedRuntimeContract>;
	projectionHome: string;
	openClawContext: ReturnType<typeof createOpenClawHostedContext>;
	hermesConfig: HermesConfigTransaction | null;
	hermesWhatsAppAuthDir: string | null;
	workspaceRoot: string;
	enabledRuntimes: string[];
	generatedAt: string;
	egressProfileBundle: ReturnType<typeof buildEgressProfileBundle>;
	plannedEgressProfileBundlePath: string | null;
	appliedState: ReturnType<typeof readRuntimeAppliedState>;
	previousProjectedProviderIds: Record<string, string[]>;
	runtimeEntries: RuntimeEntry[];
	preparedHostedSourcedSkills: NonNullable<
		RuntimeConvergenceOptions["preparedHostedSourcedSkills"]
	>;
	sourcedSkillsPrepared: boolean;
	retainPreviousProjectedProviderIds: () => Record<string, string[]>;
}

interface RuntimeConvergenceState {
	agentPluginTransaction: HostedAgentPluginTransaction | null;
	agentPluginFailedNames: Set<string>;
	agentPluginMutationAttempted: boolean;
	managedLocaleFiles: string[];
	runConfigs: string[];
	runtimeSystemdUserPrograms: RuntimeSystemdUserProgram[];
	installErrors: string[];
	resourceProjectionErrors: string[];
	projectedProviderIds: Record<string, string[]>;
	observations: Map<string, RuntimeInstallObservation>;
	openClawOwnerBrowserBootstrapSupported: boolean;
	activated: Record<string, string>;
	officialServiceCommandRevisions: Record<string, string>;
	staleSystemdFiles: RuntimeSystemdStaleFilePlan;
}

function officialServiceCommandRevision(
	context: RuntimeConvergenceContext,
	runtime: string,
): string | null {
	const unitName =
		runtime === "openclaw"
			? "openclaw-gateway.service"
			: runtime === "hermes"
				? "hermes-gateway.service"
				: null;
	return unitName
		? (context.appliedState?.officialServiceCommandRevisions?.[unitName] ?? null)
		: null;
}

function runtimeProbeRevision(context: RuntimeConvergenceContext, runtime: string): string {
	return runtimeImpactRevision({
		provider: runtimeProviderRevision(context.manifest, runtime),
		officialServiceCommand: officialServiceCommandRevision(context, runtime),
	});
}

interface RuntimeConvergencePlan {
	openClawWorkspaceRoot: string | null;
}

function resolveOpenClawWorkspaceForConvergence(
	home: string,
	repairInvalidConfig: boolean,
): string {
	if (repairInvalidConfig) repairHostedOpenClawStartupMigrations(home);
	try {
		return resolveHostedOpenClawWorkspace(home);
	} catch (error) {
		if (!repairInvalidConfig || !repairHostedOpenClawWorkspace(home, error)) throw error;
		return resolveHostedOpenClawWorkspace(home);
	}
}

function initializeRuntimeConvergence(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: RuntimeConvergenceOptions,
): { context: RuntimeConvergenceContext; state: RuntimeConvergenceState } {
	const { manifest } = load;
	if (
		hasUnsupportedAgentPluginInstallations(manifest) &&
		!opts.preparedHostedAgentPlugins &&
		!opts.resourcePreparationFailures?.agentPlugins
	) {
		throw new Error(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
	}
	const secretValues = runtimeSecretValues(load);
	const applyContext = load.applyContext;
	if (!applyContext) {
		throw new Error("runtime manifest convergence requires an explicit apply context");
	}
	const hostedRuntimeContract = assertHostedRuntimeContract(
		paths,
		applyContext,
		opts.hostedRuntimeContract,
	);
	const projectionHome = hostedRuntimeProjectionHome(manifest, paths);
	if (manifest.runtimes.openclaw?.enabled === true) {
		withRuntimeUserFileAccess(() => {
			for (const path of [
				join(projectionHome, ".openclaw"),
				join(projectionHome, ".openclaw", "tmp"),
			]) {
				mkdirSync(path, { recursive: true });
				chmodSync(path, 0o700);
			}
		}, hostedRuntimeContract.identity);
	}
	const openClawContext = createOpenClawHostedContext(manifest, projectionHome);
	const hermesWhatsAppAuthDir = managedHermesWhatsAppAuthDir(manifest, projectionHome);
	removeHostedCliPathExposure(paths);
	if (manifest.companions?.filebrowser) {
		if (!opts.systemdApply) {
			throw new Error("Files companion requires systemd apply and readiness hooks");
		}
	}
	const workspaceRoot = runtimeWorkspaceRoot(manifest, paths);
	const enabledRuntimes = Object.entries(manifest.runtimes)
		.filter(([, runtime]) => runtime.enabled)
		.map(([name]) => name)
		.sort();
	const generatedAt = new Date().toISOString();
	const egressProfileBundle = buildEgressProfileBundle({
		generatedAt,
		generation: manifest.generation,
		instanceId: manifest.instanceId,
		profiles: manifest.egressProfiles,
	});
	const plannedEgressProfileBundlePath = hasEnabledEgressProfiles(egressProfileBundle)
		? paths.egressProfileBundle
		: null;
	const appliedState = readRuntimeAppliedState(paths);
	const previousProjectedProviderIds = appliedState?.projectedProviderIds ?? {};
	const retainPreviousProjectedProviderIds = () =>
		Object.fromEntries(
			Object.entries(previousProjectedProviderIds).map(([runtime, providerIds]) => [
				runtime,
				[...providerIds],
			]),
		);
	const runtimeEntries = Object.entries(manifest.runtimes).sort(([a], [b]) => a.localeCompare(b));
	const preparedHostedSourcedSkills = opts.preparedHostedSourcedSkills ?? new Map();
	const sourcedSkillsPrepared = opts.resourcePreparationFailures?.sourcedSkills === undefined;
	const state: RuntimeConvergenceState = {
		agentPluginTransaction: null,
		agentPluginFailedNames: new Set(),
		agentPluginMutationAttempted: false,
		managedLocaleFiles: [],
		runConfigs: [],
		runtimeSystemdUserPrograms: [],
		installErrors: [],
		resourceProjectionErrors: [],
		projectedProviderIds: {},
		observations: new Map(),
		openClawOwnerBrowserBootstrapSupported: false,
		activated: {},
		officialServiceCommandRevisions: {},
		staleSystemdFiles: { platformFiles: [], userFiles: [], systemUnits: [], userUnits: [] },
	};
	if (opts.resourcePreparationFailures?.sourcedSkills) {
		state.resourceProjectionErrors.push(opts.resourcePreparationFailures.sourcedSkills);
	}
	if (opts.resourcePreparationFailures?.agentPlugins) {
		state.resourceProjectionErrors.push(opts.resourcePreparationFailures.agentPlugins.error);
		for (const name of opts.resourcePreparationFailures.agentPlugins.installationNames) {
			state.agentPluginFailedNames.add(name);
		}
	}
	return {
		context: {
			load,
			manifest,
			paths,
			opts,
			secretValues,
			applyContext,
			hostedRuntimeContract,
			projectionHome,
			openClawContext,
			hermesConfig: null,
			hermesWhatsAppAuthDir,
			workspaceRoot,
			enabledRuntimes,
			generatedAt,
			egressProfileBundle,
			plannedEgressProfileBundlePath,
			appliedState,
			previousProjectedProviderIds,
			runtimeEntries,
			preparedHostedSourcedSkills,
			sourcedSkillsPrepared,
			retainPreviousProjectedProviderIds,
		},
		state,
	};
}

function runtimeConvergenceFailure(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	includeAgentPluginFailures = false,
): RuntimeConvergenceResult {
	return runtimeConvergenceWithoutApply({
		load: context.load,
		paths: context.paths,
		workspaceRoot: context.workspaceRoot,
		enabledRuntimes: context.enabledRuntimes,
		installErrors: state.installErrors,
		projectedProviderIds: context.retainPreviousProjectedProviderIds(),
		...(includeAgentPluginFailures
			? { agentPluginFailedNames: [...state.agentPluginFailedNames].sort() }
			: {}),
	});
}

function prepareRuntimeInstallStage(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
): { result: RuntimeConvergenceResult } | null {
	const { projectionHome, runtimeEntries, paths, hostedRuntimeContract } = context;
	for (const [name, runtime] of runtimeEntries) {
		const observation = planRuntimeInstallObservation(
			name,
			runtime,
			projectionHome,
			paths,
			hostedRuntimeContract.identity,
		);
		state.observations.set(name, observation);
		if (observation.error) state.installErrors.push(observation.error);
	}
	if (state.installErrors.length > 0) {
		return { result: runtimeConvergenceFailure(context, state) };
	}
	for (const [name, runtime] of runtimeEntries) {
		const observation = observeRuntimeInstall(
			name,
			runtime,
			projectionHome,
			paths,
			hostedRuntimeContract.identity,
		);
		state.observations.set(name, observation);
		if (observation.error) state.installErrors.push(observation.error);
		if (name === "openclaw") context.openClawContext.refreshSdkExports(observation);
		if (name === "openclaw" && observation.enabled && observation.commandPath) {
			state.openClawOwnerBrowserBootstrapSupported = openClawSupportsOwnerBrowserBootstrap(
				context.openClawContext,
				runtimeProbeRevision(context, "openclaw"),
			);
		}
	}
	if (state.installErrors.length > 0) {
		return { result: runtimeConvergenceFailure(context, state) };
	}
	return null;
}

function beginRuntimeHermesConfig(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
): HermesConfigTransaction | null {
	const command =
		state.observations.get("hermes")?.commandPath ??
		runtimeCommandPath("hermes", context.projectionHome);
	if (!command || !executableExists(command)) return null;
	return beginHermesConfigTransaction({
		command,
		home: context.projectionHome,
		cwd: context.projectionHome,
	});
}

function prepareRuntimeConvergencePlan(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
): { plan: RuntimeConvergencePlan } | { result: RuntimeConvergenceResult } {
	const {
		manifest,
		paths,
		projectionHome,
		secretValues,
		previousProjectedProviderIds,
		hermesWhatsAppAuthDir,
		hermesConfig,
		workspaceRoot,
		generatedAt,
		plannedEgressProfileBundlePath,
	} = context;
	const openClawCommand = runtimeCommandPath("openclaw", projectionHome);
	const shouldResolveOpenClawWorkspace =
		manifest.runtimes.openclaw?.enabled === true ||
		Boolean(openClawCommand && executableExists(openClawCommand));
	const openClawWorkspaceRoot = shouldResolveOpenClawWorkspace
		? resolveOpenClawWorkspaceForConvergence(projectionHome, true)
		: null;
	const plannedRuntimePrograms = planRuntimeSystemdUserPrograms({
		manifest,
		paths,
		workspaceRoot,
		generatedAt,
		secretValues,
		observations: state.observations,
		egressProfileBundlePath: plannedEgressProfileBundlePath,
		egress: null,
	});
	validateRuntimeProjectionPlan({
		manifest,
		paths,
		openClawWorkspaceRoot,
		secretValues,
		observations: state.observations,
		previousProjectedProviderIds,
		hermesWhatsAppAuthDir,
		hermesConfig,
		openClawOwnerBrowserBootstrapSupported: state.openClawOwnerBrowserBootstrapSupported,
	});
	try {
		validateRuntimeSystemdPlan(plannedRuntimePrograms);
	} catch (error) {
		state.installErrors.push(error instanceof Error ? error.message : String(error));
		return { result: runtimeConvergenceFailure(context, state) };
	}
	return {
		plan: {
			openClawWorkspaceRoot,
		},
	};
}

function prepareRuntimeApplyDependencies(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
): Record<string, string> | null {
	const {
		manifest,
		paths,
		opts,
		secretValues,
		hostedRuntimeContract,
		projectionHome,
		openClawContext,
		workspaceRoot,
		runtimeEntries,
	} = context;
	ensureFileBrowserCompanion(manifest, paths, opts.fileBrowserInstallOptions);
	let codexCli: Record<string, string> | null = null;
	withRuntimeUserFileAccess(() => {
		const openClawObservation = state.observations.get("openclaw");
		if (openClawObservation) {
			try {
				ensureHostedOpenClawProviderAuthCapability({
					manifest,
					secretValues,
					context: openClawContext,
					revision: runtimeProbeRevision(context, "openclaw"),
				});
			} catch (error) {
				state.installErrors.push(
					`runtime openclaw credential capability check failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		if (state.installErrors.length > 0) throw new Error(state.installErrors.join("; "));
		const managedOpenClawObservation = state.observations.get("openclaw");
		if (managedOpenClawObservation?.commandPath) {
			removeLegacyManagedOpenClawProviderPlugin({
				home: openClawContext.home,
				stateRoot: openClawContext.stateRoot,
				commandPath: managedOpenClawObservation.commandPath,
			});
		}
		if (managedOpenClawObservation && openClawContext.managedApiKeyProjection) {
			openClawContext.agentDirs.managed = discoverOpenClawManagedProviderAuthAgentDirs(
				openClawContext,
				runtimeProbeRevision(context, "openclaw"),
			);
		}
		if (opts.preparedHostedAgentPlugins) {
			const commands = hostedAgentPluginCommands(projectionHome);
			let planned: ReturnType<typeof planHostedAgentPluginConvergence>;
			try {
				planned = planHostedAgentPluginConvergence({
					prepared: opts.preparedHostedAgentPlugins,
					home: projectionHome,
					commands,
					...(opts.hostedAgentPluginCommandRunner
						? { runner: opts.hostedAgentPluginCommandRunner }
						: {}),
					refreshCachedRuntimeProbes: opts.refreshCachedRuntimeProbes,
				});
			} catch (error) {
				for (const name of opts.preparedHostedAgentPlugins.desired.keys()) {
					state.agentPluginFailedNames.add(name);
				}
				state.resourceProjectionErrors.push(
					`runtime Agent Plugin projection planning failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				planned = { transaction: null };
			}
			state.agentPluginTransaction = planned.transaction;
			if (state.agentPluginTransaction?.hasMutations && !opts.systemdApply) {
				throw new Error("Agent Plugin mutations require systemd activation and readiness");
			}
		}

		if (manifest.projection?.terminalTooling?.codex) {
			try {
				codexCli = ensureHostedCodexCli(paths);
			} catch (error) {
				state.installErrors.push(
					`runtime codex setup failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		for (const [name] of runtimeEntries) {
			const observation = state.observations.get(name);
			if (!observation) throw new Error(`runtime ${name} install observation is missing`);
			try {
				installHostedChannelProjectionDependencies(
					name,
					observation,
					manifest,
					projectionHome,
					paths.userHome,
				);
			} catch (error) {
				state.installErrors.push(
					`runtime ${name} channel plugin install failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		const managedWhatsAppRuntime = managedWhatsAppCompatibilityRuntime(manifest);
		try {
			const observation = managedWhatsAppRuntime
				? state.observations.get(managedWhatsAppRuntime)
				: undefined;
			if (managedWhatsAppRuntime && !observation?.appRoot) {
				throw new Error(`runtime ${managedWhatsAppRuntime} artifact root is unavailable`);
			}
			const compatibility = reconcileManagedBaileysCompatibility({
				desiredRuntime: managedWhatsAppRuntime,
				home: projectionHome,
				...(observation?.appRoot ? { appRoot: observation.appRoot } : {}),
			});
			if (compatibility.status === "rollback-refused") {
				throw new Error(compatibility.errors.join(", "));
			}
		} catch (error) {
			const operation = managedWhatsAppRuntime
				? `runtime ${managedWhatsAppRuntime} managed WhatsApp compatibility`
				: "runtime managed WhatsApp compatibility cleanup";
			state.installErrors.push(
				`${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (state.installErrors.length > 0) throw new Error(state.installErrors.join("; "));
		mkdirSync(workspaceRoot, { recursive: true });
	}, hostedRuntimeContract.identity);
	ensureRuntimeUserCliStateRoot(paths.clawdiHome, hostedRuntimeContract.identity);
	ensureRuntimePlatformDirectory(paths, paths.managedSecretRoot);
	makeManagedSecretRoot(paths.managedSecretRoot);
	ensureRuntimePlatformDirectory(paths, paths.egressRoot, { mode: 0o711 });
	chmodSync(paths.egressRoot, 0o711);
	makeEgressIdentityPrivateDir(paths.egressCaDir);
	ensureRuntimePlatformDirectory(paths, dirname(paths.egressSystemCaFile), { mode: 0o711 });
	chmodSync(dirname(paths.egressSystemCaFile), 0o711);
	return codexCli;
}

interface RuntimeEgressProjection {
	egressProfileBundlePath: ReturnType<typeof writeEgressProfileBundle> | null;
	egressEngine: ReturnType<typeof ensureRuntimeMitmproxy> | null;
	egressAddon: ReturnType<typeof writeEgressAddon> | null;
	daemonAuthTokenFile: ReturnType<typeof writeDaemonAuthToken>;
	egressSecretFile: ReturnType<typeof writeEgressSecretFile>["path"];
	egressSystemdProgram: ReturnType<typeof resolveRuntimeSystemdIdentity>["egressProgram"];
	egressIdentity: ReturnType<typeof resolveRuntimeSystemdIdentity>["identity"];
	egressTransparentEnv: ReturnType<typeof writeTransparentEgressEnvFile>;
	liveSyncEnvironments: ReturnType<typeof writeLiveSyncEnvironmentFiles>;
	writtenRunConfigIds: Set<string>;
	commonSystemdEnvironment: ReturnType<typeof runtimeSystemdCommonEnvironment>;
}

function prepareRuntimeEgressProjection(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
): RuntimeEgressProjection {
	const {
		manifest,
		paths,
		opts,
		secretValues,
		hostedRuntimeContract,
		projectionHome,
		workspaceRoot,
		generatedAt,
		egressProfileBundle,
	} = context;
	const egressProfileBundlePath = hasEnabledEgressProfiles(egressProfileBundle)
		? writeEgressProfileBundle(egressProfileBundle, paths)
		: clearEgressProfileBundle(paths);
	const egressEngine = egressProfileBundlePath
		? ensureRuntimeMitmproxy(manifest.egressEngine, paths, opts.egressEngineEnsureOptions)
		: null;
	requireV2EgressEngineReady(egressProfileBundlePath, egressEngine);
	const egressAddon = egressProfileBundlePath ? writeEgressAddon(paths) : clearEgressAddon(paths);
	const daemonAuthTokenFile = writeDaemonAuthToken(paths, secretValues);
	let liveSyncEnvironments: string[] = [];
	withRuntimeUserFileAccess(() => {
		try {
			materializeHostedChannelCredentials(manifest, secretValues, projectionHome);
		} catch (error) {
			state.installErrors.push(
				`runtime channel credential materialization failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		liveSyncEnvironments = writeLiveSyncEnvironmentFiles(manifest, paths);
	}, hostedRuntimeContract.identity);
	const egressSecretFile = writeEgressSecretFile(manifest, secretValues, paths).path;
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	const resolvedSystemdIdentity = resolveRuntimeSystemdIdentity({
		paths,
		profileBundlePath: egressProfileBundlePath,
		secretFilePath: egressSecretFile,
		engine: egressEngine,
		addon: egressAddon,
		runtimeIdentity: hostedRuntimeContract.identity,
	});
	const egressSystemdProgram = resolvedSystemdIdentity.egressProgram;
	const egressIdentity = resolvedSystemdIdentity.identity;
	const runtimeUid = egressIdentity?.runtimeUid ?? 0;
	const runtimeGid = egressIdentity?.runtimeGid ?? 0;
	const egressUid = egressIdentity?.egressUid ?? 0;
	const egressGid = egressIdentity?.egressGid ?? 0;
	const egressTransparentEnv = writeTransparentEgressEnvFile({
		program: egressSystemdProgram,
		paths,
		runtimeUser,
		runtimeUid,
		runtimeGid,
		egressUid,
		egressGid,
	});
	const writtenRunConfigIds = new Set<string>();
	state.runtimeSystemdUserPrograms.push(
		...planRuntimeSystemdUserPrograms({
			manifest,
			paths,
			workspaceRoot,
			generatedAt,
			secretValues,
			observations: state.observations,
			egressProfileBundlePath,
			egress: egressSystemdProgram,
		}),
	);
	return {
		egressProfileBundlePath,
		egressEngine,
		egressAddon,
		daemonAuthTokenFile,
		egressSecretFile,
		egressSystemdProgram,
		egressIdentity,
		egressTransparentEnv,
		liveSyncEnvironments,
		writtenRunConfigIds,
		commonSystemdEnvironment: runtimeSystemdCommonEnvironment(paths),
	};
}

function applyRuntimeResourceProjections(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	plan: RuntimeConvergencePlan,
	codexCli: Record<string, string> | null,
): Partial<Record<string, string | null>> {
	const {
		manifest,
		paths,
		secretValues,
		projectionHome,
		openClawContext,
		hermesWhatsAppAuthDir,
		hermesConfig,
		workspaceRoot,
		previousProjectedProviderIds,
		runtimeEntries,
		preparedHostedSourcedSkills,
		sourcedSkillsPrepared,
	} = context;
	// Capability repair and managed auth-target discovery can change the plan;
	// this second validation is an intentional post-repair revalidation.
	validateRuntimeProjectionPlan({
		manifest,
		paths,
		openClawWorkspaceRoot: plan.openClawWorkspaceRoot,
		secretValues,
		observations: state.observations,
		previousProjectedProviderIds,
		hermesWhatsAppAuthDir,
		hermesConfig,
		openClawOwnerBrowserBootstrapSupported: state.openClawOwnerBrowserBootstrapSupported,
	});
	const providerProjectionRevisions: Partial<Record<string, string | null>> = {};
	for (const [name] of runtimeEntries) {
		const observation = state.observations.get(name);
		if (!observation) throw new Error(`runtime ${name} install observation is missing`);
		providerProjectionRevisions[name] = previewHostedAiProviderProjectionRevision(
			name,
			observation,
			manifest,
			projectionHome,
			previousProjectedProviderIds[name] ?? [],
		);
	}
	try {
		const codexProjection = withRuntimeUserFileAccess(
			() => applyHostedCodexManagedProviderProjection(manifest, projectionHome, codexCli),
			context.hostedRuntimeContract.identity,
		);
		providerProjectionRevisions.codex = codexProjection.revision;
		state.projectedProviderIds.codex = codexProjection.providerIds;
	} catch (error) {
		state.installErrors.push(
			`runtime codex provider projection failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (state.installErrors.length > 0) throw new Error(state.installErrors.join("; "));
	if (sourcedSkillsPrepared) {
		try {
			state.resourceProjectionErrors.push(
				...reconcileHostedSkillProjection({
					manifest,
					observations: state.observations,
					home: projectionHome,
					managedResourceRoot: paths.managedResourceRoot,
					openClawWorkspaceRoot: plan.openClawWorkspaceRoot,
					preparedSourcedSkills: preparedHostedSourcedSkills,
				}),
			);
		} catch (error) {
			state.resourceProjectionErrors.push(error instanceof Error ? error.message : String(error));
		}
	}
	try {
		applyHostedMcpProjections(manifest, paths, state.observations, workspaceRoot, hermesConfig);
	} catch (error) {
		state.installErrors.push(
			`runtime MCP projection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (state.installErrors.length > 0) throw new Error(state.installErrors.join("; "));

	for (const runtime of ["hermes", "openclaw"] as const) {
		if (Object.hasOwn(manifest.runtimes, runtime)) continue;
		try {
			reconcileHostedRuntimeOAuthCredentials({
				runtime,
				manifest,
				secretValues,
				paths,
				home: projectionHome,
				openClawContext,
				workspaceRoot,
			});
		} catch (error) {
			state.installErrors.push(
				`stale ${runtime} OAuth credential reconciliation failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	if (state.installErrors.length > 0) throw new Error(state.installErrors.join("; "));
	return providerProjectionRevisions;
}

function applyRuntimeEntryProjections(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	plan: RuntimeConvergencePlan,
	egressProjection: RuntimeEgressProjection,
): void {
	const {
		manifest,
		paths,
		secretValues,
		projectionHome,
		openClawContext,
		hermesWhatsAppAuthDir,
		hermesConfig,
		workspaceRoot,
		generatedAt,
		previousProjectedProviderIds,
		runtimeEntries,
	} = context;
	for (const [name, runtime] of runtimeEntries) {
		const observation = state.observations.get(name);
		if (!observation) throw new Error(`runtime ${name} install observation is missing`);

		if (name === "hermes" || name === "openclaw") {
			try {
				reconcileHostedRuntimeOAuthCredentials({
					runtime: name,
					manifest,
					secretValues,
					paths,
					home: projectionHome,
					openClawContext,
					workspaceRoot,
				});
			} catch (error) {
				state.installErrors.push(
					`runtime ${name} OAuth credential reconciliation failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		const resolved = withRuntimeUserFileAccess(() => {
			try {
				const localeFile = applyHostedRuntimeConfigProjection(
					name,
					manifest,
					projectionHome,
					plan.openClawWorkspaceRoot,
					workspaceRoot,
					hermesConfig,
				);
				if (localeFile) state.managedLocaleFiles.push(localeFile);
			} catch (error) {
				state.installErrors.push(
					`runtime ${name} config projection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			try {
				const providerProjection = applyHostedAiProviderProjection(
					name,
					observation,
					manifest,
					secretValues,
					projectionHome,
					openClawContext,
					workspaceRoot,
					previousProjectedProviderIds[name] ?? [],
					state.openClawOwnerBrowserBootstrapSupported,
					hermesConfig,
					runtimeProbeRevision(context, name),
				);
				state.projectedProviderIds[name] = providerProjection.providerIds;
			} catch (error) {
				state.installErrors.push(
					`runtime ${name} provider projection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			try {
				applyHostedChannelProjection(
					name,
					observation,
					manifest,
					projectionHome,
					openClawContext,
					workspaceRoot,
					hermesWhatsAppAuthDir,
					hermesConfig,
				);
			} catch (error) {
				state.installErrors.push(
					`runtime ${name} channel projection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			if (state.installErrors.length > 0) throw new Error(state.installErrors.join("; "));
			return resolveRuntimeRunConfigs({
				manifest,
				paths,
				name,
				runtime,
				observation,
				workspaceRoot,
				generatedAt,
				secretValues,
				egressProfileBundlePath: egressProjection.egressProfileBundlePath,
			});
		}, context.hostedRuntimeContract.identity);
		const runConfigPath = writeRuntimeRunConfig(resolved.runtime, paths);
		state.runConfigs.push(runConfigPath);
		egressProjection.writtenRunConfigIds.add(runtimeRunConfigId(resolved.runtime.runtime));
		for (const serviceRunConfig of resolved.services) {
			const serviceRunConfigPath = writeRuntimeRunConfig(serviceRunConfig, paths);
			state.runConfigs.push(serviceRunConfigPath);
			egressProjection.writtenRunConfigIds.add(
				runtimeRunConfigId(serviceRunConfig.runtime, serviceRunConfig.service),
			);
		}
	}
}

interface RuntimeActivationPlan {
	systemdUnits: ReturnType<typeof writeRuntimeSystemdState>;
	officialServicePlan: ReturnType<typeof planOfficialRuntimeServices>;
	publishSystemdUnits: (
		deferredRuntimeUserUnitNames?: readonly string[],
	) => ReturnType<typeof writeRuntimeSystemdState>;
}

function prepareRuntimeActivation(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	egressProjection: RuntimeEgressProjection,
	providerProjectionRevisions: Partial<Record<string, string | null>>,
): RuntimeActivationPlan {
	const { manifest, paths, opts, secretValues, hermesWhatsAppAuthDir, workspaceRoot } = context;
	const officialServicePlan = planOfficialRuntimeServices(
		state.runtimeSystemdUserPrograms,
		paths,
		opts.systemdApply !== undefined || opts.executeOfficialServiceInstallers === true,
	);
	const publishSystemdUnits = (deferredRuntimeUserUnitNames: readonly string[] = []) =>
		writeRuntimeSystemdState({
			runtimePrograms: state.runtimeSystemdUserPrograms,
			egressProgram: egressProjection.egressSystemdProgram,
			egressIdentity: egressProjection.egressIdentity,
			runtimeIdentity: context.hostedRuntimeContract.identity,
			manifest,
			paths,
			workspaceRoot,
			daemonAuthTokenFile: egressProjection.daemonAuthTokenFile,
			secretValues,
			providerProjectionRevisions,
			runtimeRevision: (desired, runtime, secrets, providerRevision) =>
				runtimeProgramRevisionForManifest(
					desired,
					runtime,
					secrets,
					providerRevision,
					hermesWhatsAppAuthDir,
					state.openClawOwnerBrowserBootstrapSupported,
				),
			commonEnvironment: egressProjection.commonSystemdEnvironment,
			// OpenClaw 2026.8.1 validates the effective service definition during
			// install. Publish Clawdi's drop-in only after the installer has created
			// the official base unit.
			deferredRuntimeUserUnitNames,
		});
	const systemdUnits = publishSystemdUnits(
		// Hermes permits its environment before installation and defers startup to activation.
		officialServicePlan.pending
			.filter((item) => item.program.runtime === "openclaw")
			.map((item) => item.unitName),
	);
	state.staleSystemdFiles = systemdUnits.staleFiles;
	const staleSystemdFileErrors = removeStaleRuntimeSystemdFiles(state.staleSystemdFiles);
	if (staleSystemdFileErrors.length > 0) throw new Error(staleSystemdFileErrors.join("; "));
	// Agent Plugin mutations must precede every native service installer.
	const appliedAgentPluginTransaction = state.agentPluginTransaction;
	if (appliedAgentPluginTransaction?.hasMutations) {
		state.agentPluginMutationAttempted = true;
	}
	try {
		if (appliedAgentPluginTransaction) {
			const receipt = appliedAgentPluginTransaction.apply();
			writeHostedAgentPluginReceipt(receipt, paths);
		}
	} catch (error) {
		for (const name of appliedAgentPluginTransaction?.mutationNames ?? []) {
			state.agentPluginFailedNames.add(name);
		}
		state.resourceProjectionErrors.push(
			`runtime Agent Plugin projection failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		state.agentPluginTransaction = null;
		state.agentPluginMutationAttempted = false;
	}
	return { systemdUnits, officialServicePlan, publishSystemdUnits };
}

interface RuntimeActivationOutputs {
	manifestLastGood: string | null;
}

function activateRuntimeServices(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	activationPlan: RuntimeActivationPlan,
): RuntimeActivationOutputs {
	const { load, manifest, paths, opts, hostedRuntimeContract } = context;
	const { officialServicePlan, systemdUnits } = activationPlan;
	if (
		officialServicePlan.pending.length > 0 &&
		systemdUnits.egressSidecarActive &&
		opts.systemdApply
	) {
		const prerequisite = opts.systemdApply.activateEgressPrerequisite({
			staleSystemUnits: [],
			staleUserUnits: [],
			invalidatedUserUnits: [],
		});
		if (!prerequisite.applied) {
			throw new Error("transparent-egress system prerequisites did not reach readiness");
		}
	}
	const dependencyError = prepareOfficialRuntimeServiceDependencies(
		state.runtimeSystemdUserPrograms,
		officialServicePlan,
		paths,
		systemdUnits.egressSidecarActive ? paths.egressSystemCaFile : undefined,
	);
	if (dependencyError) throw new Error(dependencyError);

	for (const item of officialServicePlan.pending) {
		const error = installOfficialRuntimeService(item, paths, hostedRuntimeContract.identity);
		if (error) throw new Error(error);
		if (!item.serviceRevision) {
			throw new Error(`official ${item.unitName} service revision could not be verified`);
		}
		officialServicePlan.serviceRevisions[item.unitName] = item.serviceRevision;
	}
	if (officialServicePlan.pending.length > 0) {
		activationPlan.systemdUnits = activationPlan.publishSystemdUnits();
	}
	state.officialServiceCommandRevisions = officialServicePlan.serviceRevisions;
	if (opts.systemdApply) {
		const activation = opts.systemdApply.activate({
			staleSystemUnits: state.staleSystemdFiles.systemUnits,
			staleUserUnits: state.staleSystemdFiles.userUnits,
			invalidatedUserUnits: officialServicePlan.pending.map((item) => item.unitName),
		});
		if (!activation.applied) {
			throw new Error("systemd runtime services did not reach required readiness");
		}
		state.activated = activation.activated ?? {};
		probeFileBrowserReadiness(manifest, { probe: opts.fileBrowserReadinessProbe });
	}
	let manifestLastGood: string | null = null;
	if (
		state.installErrors.length === 0 &&
		opts.cacheLastGood !== false &&
		load.sourceBundle !== undefined
	) {
		manifestLastGood = writeLastGoodManifest(load.sourceBundle, paths, load.secretValues, manifest);
	}
	return { manifestLastGood };
}

function buildRuntimeConvergenceResult(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	egressProjection: RuntimeEgressProjection,
	activationPlan: RuntimeActivationPlan,
	activationOutputs: RuntimeActivationOutputs,
): RuntimeConvergenceResult {
	const { load, manifest, paths, workspaceRoot, enabledRuntimes } = context;
	return {
		manifest,
		source: load.source,
		sourcePath: load.sourcePath,
		offline: load.offline,
		mode: load.offline ? "degraded-offline" : "normal",
		enabledRuntimes,
		installErrors: state.installErrors,
		resourceProjectionErrors: state.resourceProjectionErrors,
		projectedProviderIds: state.projectedProviderIds,
		agentPluginFailedNames: [...state.agentPluginFailedNames].sort(),
		outputs: {
			processManager: "systemd",
			workspaceRoot,
			manifestLastGood: activationOutputs.manifestLastGood,
			appliedState: null,
			managedLocaleFiles: state.managedLocaleFiles,
			runConfigs: state.runConfigs,
			systemdSystemUnitRoot: paths.systemdSystemRoot,
			systemdSystemUnits: activationPlan.systemdUnits.systemUnits,
			systemdUserUnitRoot: paths.systemdUserRoot,
			systemdUserUnits: activationPlan.systemdUnits.userUnits,
			egressProfileBundle: egressProjection.egressProfileBundlePath,
			egressSecretFile: egressProjection.egressSecretFile,
			egressEngine: egressProjection.egressEngine,
			egressTransparentEnv: egressProjection.egressTransparentEnv,
			egressAddon: egressProjection.egressAddon?.path ?? null,
			liveSyncEnvironments: egressProjection.liveSyncEnvironments,
			daemonAuthTokenFile: egressProjection.daemonAuthTokenFile,
		},
	};
}

function commitRuntimeConvergence(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	egressProjection: RuntimeEgressProjection,
	convergence: RuntimeConvergenceResult,
): void {
	const { manifest, paths, opts, workspaceRoot } = context;
	if (state.installErrors.length > 0) return;
	opts.commitAuthority?.(convergence, {
		activated: state.activated,
		officialServiceCommandRevisions: state.officialServiceCommandRevisions,
	});
	try {
		gcFileBrowserCompanionCandidates(manifest, paths);
	} catch (cleanupError) {
		console.warn(
			`post-commit Files companion candidate cleanup deferred: ${
				cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
			}`,
		);
	}
	try {
		removeStaleRuntimeRunConfigs(egressProjection.writtenRunConfigIds, paths);
	} catch (cleanupError) {
		console.warn(
			`post-commit runtime file cleanup deferred: ${
				cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
			}`,
		);
	}
	for (const cleanupError of uninstallStaleOfficialRuntimeServices({
		paths,
		unitNames: state.staleSystemdFiles.userUnits,
		workspaceRoot,
	})) {
		console.warn(`post-commit official runtime service cleanup deferred: ${cleanupError}`);
	}
}

function runtimeApplyFailure(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	error: unknown,
): RuntimeConvergenceResult {
	if (state.agentPluginMutationAttempted) {
		for (const name of state.agentPluginTransaction?.mutationNames ?? []) {
			state.agentPluginFailedNames.add(name);
		}
	}
	state.installErrors.unshift(
		`runtime apply failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	return runtimeConvergenceFailure(context, state, true);
}

export function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: RuntimeConvergenceOptions = {},
): RuntimeConvergenceResult {
	const { context, state } = initializeRuntimeConvergence(load, paths, opts);
	const installResult = prepareRuntimeInstallStage(context, state);
	if (installResult) return installResult.result;
	context.hermesConfig = beginRuntimeHermesConfig(context, state);
	const planResult = prepareRuntimeConvergencePlan(context, state);
	if ("result" in planResult) return planResult.result;
	const plan = planResult.plan;
	try {
		const codexCli = prepareRuntimeApplyDependencies(context, state);
		const egressProjection = prepareRuntimeEgressProjection(context, state);
		const providerProjectionRevisions = applyRuntimeResourceProjections(
			context,
			state,
			plan,
			codexCli,
		);

		applyRuntimeEntryProjections(context, state, plan, egressProjection);
		if (context.hermesConfig) {
			const hermesConfig = context.hermesConfig;
			const commitResult = withRuntimeUserFileAccess(
				() => commitHermesConfigTransaction(hermesConfig),
				context.hostedRuntimeContract.identity,
			);
			if (commitResult === "conflict") {
				return {
					...runtimeConvergenceFailure(context, state),
					deferredReason: "hermes_config_conflict",
				};
			}
		}
		const activationPlan = prepareRuntimeActivation(
			context,
			state,
			egressProjection,
			providerProjectionRevisions,
		);
		const activationOutputs = activateRuntimeServices(context, state, activationPlan);
		const convergence = buildRuntimeConvergenceResult(
			context,
			state,
			egressProjection,
			activationPlan,
			activationOutputs,
		);
		commitRuntimeConvergence(context, state, egressProjection, convergence);
		return convergence;
	} catch (error) {
		return runtimeApplyFailure(context, state, error);
	}
}
