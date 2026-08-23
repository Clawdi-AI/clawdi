import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readRuntimeAppliedState } from "./applied-state";
import { readRuntimeAuthToken } from "./auth-token";
import { removeHostedCliPathExposure } from "./cli-update";
import { buildEgressProfileBundle, hasEnabledEgressProfiles } from "./egress-profiles";
import {
	ensureFileBrowserCompanion,
	gcFileBrowserCompanionCandidates,
	probeFileBrowserReadiness,
} from "./file-browser-companion";
import {
	hostedAgentPluginReceiptsPath,
	writeHostedAgentPluginReceipt,
} from "./hosted-agent-plugin-package";
import {
	type HostedAgentPluginTransaction,
	hostedAgentPluginCommands,
} from "./hosted-agent-plugin-runtime";
import {
	createOpenClawHostedContext,
	hostedOpenClawRuntimeUserOwnership,
	repairHostedOpenClawConfig,
	resolveHostedOpenClawWorkspace,
} from "./hosted-openclaw-context";
import { assertHostedRuntimeContract } from "./hosted-runtime-contract";
import { captureRuntimeLiveSnapshot, type RuntimeLiveSnapshot } from "./live-state-snapshot";
import { reconcileManagedBaileysCompatibility } from "./managed-baileys-compat";
import { managedHermesWhatsAppAuthDir } from "./managed-channel-reconciliation";
import { managedSkillReservationLedgerPath } from "./managed-skill-reservation";
import {
	applyHostedChannelProjection,
	installHostedChannelProjectionDependencies,
	materializeHostedChannelCredentials,
} from "./manifest-channels";
import {
	AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR,
	AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR,
	HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION,
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
	runtimeColdInstallMutationPlan,
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
	hostedSkillMutationTargets,
	managedOpenClawPluginBootstrapMutationPlan,
	managedWhatsAppCompatibilityRuntime,
	planHostedAgentPluginConvergence,
	planRuntimeSystemdUserPrograms,
	type RuntimeConvergenceOptions,
	type RuntimeSnapshotRollbackScope,
	RuntimeSnapshotRollbackStack,
	resolveRuntimeRunConfigs,
	runtimeConvergenceWithoutApply,
	runtimeManagedMutationPlan,
	runtimeSecretValues,
	runtimeWorkspaceRoot,
	validateRuntimeProjectionPlan,
} from "./manifest-planning";
import {
	applyHostedAiProviderProjection,
	applyHostedCodexManagedProviderProjection,
	ensureHostedCodexCli,
	hostedCodexManagedProvider,
	previewHostedAiProviderProjectionRevision,
} from "./manifest-providers";
import { applyHostedRuntimeConfigProjection } from "./manifest-runtime-config";
import {
	daemonAuthTokenRevision,
	removeStaleRuntimeRunConfigs,
	runtimeProgramRevisionForManifest,
	writeDaemonAuthToken,
	writeLiveSyncEnvironmentFiles,
} from "./manifest-runtime-state";
import {
	egressSecretFilePath,
	makeManagedSecretRoot,
	type RuntimeEgressSecretMaterial,
	verifiedCommittedEgressSecretMaterial,
	writeEgressSecretFile,
	writeEgressSecretMaterial,
	writeLastGoodManifest,
} from "./manifest-secrets";
import { mutationAncestorMetadataTargets, type RuntimeConvergenceResult } from "./manifest-shared";
import { reconcileHostedSkillProjection } from "./manifest-skills-apply";
import type { RuntimeManifestLoad } from "./manifest-source";
import { ensureRuntimeMitmproxy } from "./mitmproxy-fetch";
import { ensureManagedOpenClawProviderPlugin } from "./openclaw-managed-provider-plugin";
import { type RuntimePaths, runtimeSystemdPlatformEnclaves } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import { runtimeRunConfigId, writeRuntimeRunConfig } from "./run-config";
import { daemonProgramRevision } from "./runtime-impact-revision";
import {
	installOfficialRuntimeService,
	planOfficialRuntimeServices,
	planRuntimeMutationSystemdUserUnits,
	type RuntimeSystemdStaleFilePlan,
	type RuntimeSystemdUserProgram,
	removeStaleRuntimeSystemdFiles,
	resolveRuntimeSystemdIdentity,
	runtimeSystemdCommonEnvironment,
	runtimeSystemdUserUnitName,
	uninstallStaleOfficialRuntimeServices,
	validateRuntimeSystemdPlan,
	writeRuntimeSystemdState,
} from "./runtime-systemd-reconciliation";
import {
	enforceRuntimeUserOwnership,
	enforceRuntimeUserSystemdManagerAccess,
	executableExists,
	makeRuntimeUserOwned,
	runtimePlatformEnclaveOwnership,
	runtimeUserDirectoryOwnership,
	runtimeUserExistingOwnership,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
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
	platformEnclaves: ReturnType<typeof runtimeSystemdPlatformEnclaves>;
	openClawContext: ReturnType<typeof createOpenClawHostedContext>;
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
	agentPluginQuiesceAttempted: boolean;
	agentPluginUnitsQuiesced: boolean;
	agentPluginMutationAttempted: boolean;
	agentPluginQuiesceUserUnits: string[];
	agentPluginRestartUserUnits: string[];
	runtimeProjectionMutationRuntimes: Set<string>;
	runtimeProjectionRestartUserUnits: string[];
	managedLocaleFiles: string[];
	runConfigs: string[];
	runtimeSystemdUserPrograms: RuntimeSystemdUserProgram[];
	installErrors: string[];
	resourceProjectionErrors: string[];
	projectedProviderIds: Record<string, string[]>;
	observations: Map<string, RuntimeInstallObservation>;
	openClawOwnerBrowserBootstrapSupported: boolean;
	rollbackSnapshots: RuntimeSnapshotRollbackStack;
	systemdActivationApplied: boolean;
	restartDaemon: boolean;
	desiredDaemonAuthTokenRevision?: string;
	desiredDaemonProgramRevision?: string;
	restartEgressSidecar: boolean;
	desiredEgressSidecarSecretRevision?: string;
	officialServiceCommandRevisions: Record<string, string>;
	rollbackEgressSecretOverride?: RuntimeEgressSecretMaterial;
	rollbackEgressSecretRevision?: string;
	egressRollbackAuthorityVerified: boolean;
	staleSystemdFiles: RuntimeSystemdStaleFilePlan;
}

interface RuntimeInstallStage {
	coldInstallPlan: ReturnType<typeof runtimeColdInstallMutationPlan>;
	pluginBootstrapPlan: ReturnType<typeof managedOpenClawPluginBootstrapMutationPlan>;
}

interface RuntimeConvergencePlan extends RuntimeInstallStage {
	openClawWorkspaceRoot: string | null;
	plannedRuntimePrograms: RuntimeSystemdUserProgram[];
	mutationPlan: ReturnType<typeof runtimeManagedMutationPlan>;
	workspaceExistedBeforeApply: boolean;
	liveSnapshot: RuntimeLiveSnapshot;
	resourceRollbackScope: RuntimeSnapshotRollbackScope;
}

function resolveOpenClawWorkspaceForConvergence(
	home: string,
	repairInvalidConfig: boolean,
): string {
	try {
		return resolveHostedOpenClawWorkspace(home);
	} catch (error) {
		if (!repairInvalidConfig || !repairHostedOpenClawConfig(home)) throw error;
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
		(hasUnsupportedAgentPluginInstallations(manifest) || opts.preparedHostedAgentPlugins) &&
		manifest.projection?.sourceBundleVersion !== HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION
	) {
		throw new Error(AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR);
	}
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
	// Tenant HOME belongs to the runtime user except for declared platform
	// enclaves. Ownership repair precedes snapshots by design.
	const platformEnclaves =
		resolve(projectionHome) === resolve(paths.userHome)
			? runtimeSystemdPlatformEnclaves(paths)
			: [];
	if (platformEnclaves.some((enclave) => enclave.path === paths.systemdUserRoot)) {
		enforceRuntimeUserSystemdManagerAccess(paths.systemdUserRoot);
	}
	enforceRuntimeUserOwnership([
		...runtimeUserDirectoryOwnership(projectionHome, { recursive: true, platformEnclaves }),
		...hostedOpenClawRuntimeUserOwnership(manifest, projectionHome),
	]);
	const openClawContext = createOpenClawHostedContext(manifest, projectionHome);
	const hermesWhatsAppAuthDir = managedHermesWhatsAppAuthDir(manifest, projectionHome);
	removeHostedCliPathExposure(paths);
	if (manifest.companions?.filebrowser) {
		if (manifest.projection?.sourceBundleVersion !== HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION) {
			throw new Error("Files companion requires a hosted v2 bundle");
		}
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
		agentPluginQuiesceAttempted: false,
		agentPluginUnitsQuiesced: false,
		agentPluginMutationAttempted: false,
		agentPluginQuiesceUserUnits: [],
		agentPluginRestartUserUnits: [],
		runtimeProjectionMutationRuntimes: new Set(),
		runtimeProjectionRestartUserUnits: [],
		managedLocaleFiles: [],
		runConfigs: [],
		runtimeSystemdUserPrograms: [],
		installErrors: [],
		resourceProjectionErrors: [],
		projectedProviderIds: {},
		observations: new Map(),
		openClawOwnerBrowserBootstrapSupported: false,
		rollbackSnapshots: new RuntimeSnapshotRollbackStack(),
		systemdActivationApplied: false,
		restartDaemon: false,
		restartEgressSidecar: false,
		officialServiceCommandRevisions: {},
		egressRollbackAuthorityVerified: true,
		staleSystemdFiles: { files: [], systemUnits: [], userUnits: [] },
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
			platformEnclaves,
			openClawContext,
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

function rollbackRuntimeInstallFailure(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	error: unknown,
): RuntimeConvergenceResult {
	state.installErrors.push(...state.rollbackSnapshots.restore());
	const message = error instanceof Error ? error.message : String(error);
	if (!state.installErrors.includes(message)) state.installErrors.unshift(message);
	return runtimeConvergenceFailure(context, state);
}

function prepareRuntimeInstallStage(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
): { stage: RuntimeInstallStage } | { result: RuntimeConvergenceResult } {
	const { manifest, paths, projectionHome, runtimeEntries, hostedRuntimeContract } = context;
	for (const [name, runtime] of runtimeEntries) {
		const observation = planRuntimeInstallObservation(name, runtime, projectionHome);
		state.observations.set(name, observation);
		if (observation.error) state.installErrors.push(observation.error);
	}
	if (state.installErrors.length > 0) {
		return { result: runtimeConvergenceFailure(context, state) };
	}
	const coldInstallPlan = runtimeColdInstallMutationPlan(manifest, paths, state.observations);
	if (coldInstallPlan) {
		state.rollbackSnapshots.capture("runtime installer rollback failed", coldInstallPlan.snapshot);
	}
	const pluginBootstrapPlan = managedOpenClawPluginBootstrapMutationPlan(
		context.openClawContext,
		paths,
	);
	try {
		if (coldInstallPlan) {
			hostedRuntimeContract.assertPlatformRoots();
			enforceRuntimeUserOwnership(coldInstallPlan.runtimeUserOwnership);
		}
		for (const [name, runtime] of runtimeEntries) {
			const observation = observeRuntimeInstall(name, runtime, projectionHome);
			state.observations.set(name, observation);
			if (observation.error) state.installErrors.push(observation.error);
			if (name === "openclaw") context.openClawContext.refreshSdkExports(observation);
			if (name === "openclaw" && observation.enabled && observation.commandPath) {
				state.openClawOwnerBrowserBootstrapSupported = openClawSupportsOwnerBrowserBootstrap(
					context.openClawContext,
				);
			}
		}
		if (state.installErrors.length > 0) throw new Error(state.installErrors.join("; "));
		if (pluginBootstrapPlan) {
			state.rollbackSnapshots.capture(
				"OpenClaw managed provider plugin rollback failed",
				pluginBootstrapPlan,
			);
			enforceRuntimeUserOwnership(
				runtimeUserExistingOwnership([
					...pluginBootstrapPlan.metadataTargets,
					...pluginBootstrapPlan.runtimeUserTargets,
				]),
			);
		}
	} catch (error) {
		return { result: rollbackRuntimeInstallFailure(context, state, error) };
	}
	return { stage: { coldInstallPlan, pluginBootstrapPlan } };
}

function prepareRuntimeConvergencePlan(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	installStage: RuntimeInstallStage,
): { plan: RuntimeConvergencePlan } | { result: RuntimeConvergenceResult } {
	const {
		manifest,
		paths,
		projectionHome,
		openClawContext,
		secretValues,
		previousProjectedProviderIds,
		hermesWhatsAppAuthDir,
		workspaceRoot,
		generatedAt,
		plannedEgressProfileBundlePath,
	} = context;
	let openClawWorkspaceRoot: string | null;
	let plannedRuntimePrograms: RuntimeSystemdUserProgram[];
	let mutationPlan: ReturnType<typeof runtimeManagedMutationPlan>;
	try {
		const openClawCommand = runtimeCommandPath("openclaw", projectionHome);
		const shouldResolveOpenClawWorkspace =
			manifest.runtimes.openclaw?.enabled === true ||
			Boolean(openClawCommand && executableExists(openClawCommand));
		openClawWorkspaceRoot = shouldResolveOpenClawWorkspace
			? resolveOpenClawWorkspaceForConvergence(
					projectionHome,
					manifest.projection?.sourceBundleVersion === HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION,
				)
			: null;
		plannedRuntimePrograms = planRuntimeSystemdUserPrograms({
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
			openClawOwnerBrowserBootstrapSupported: state.openClawOwnerBrowserBootstrapSupported,
		});
		validateRuntimeSystemdPlan(plannedRuntimePrograms);
		mutationPlan = runtimeManagedMutationPlan({
			manifest,
			paths,
			openClawWorkspaceRoot,
			openClawContext,
			programs: plannedRuntimePrograms,
			observations: state.observations,
		});
	} catch (error) {
		throw state.rollbackSnapshots.failure(error);
	}
	if (installStage.pluginBootstrapPlan) {
		try {
			const observation = state.observations.get("openclaw");
			if (!observation?.commandPath) {
				throw new Error("OpenClaw managed provider plugin requires an installed runtime");
			}
			ensureManagedOpenClawProviderPlugin({
				context: openClawContext,
				commandPath: observation.commandPath,
			});
		} catch (error) {
			return { result: rollbackRuntimeInstallFailure(context, state, error) };
		}
	}
	if (mutationPlan.systemdDriftErrors.length > 0) {
		state.installErrors.push(...state.rollbackSnapshots.restore());
		state.installErrors.push(...mutationPlan.systemdDriftErrors);
		return { result: runtimeConvergenceFailure(context, state) };
	}
	const workspaceExistedBeforeApply = withRuntimeUserFileAccess(() => existsSync(workspaceRoot));
	let liveSnapshot: RuntimeLiveSnapshot;
	try {
		liveSnapshot = state.rollbackSnapshots.capture(
			"runtime filesystem rollback failed",
			mutationPlan.snapshot,
		);
	} catch (error) {
		throw state.rollbackSnapshots.failure(error);
	}
	// Resource snapshots live below tenant-owned roots and restore before the
	// platform-root assertion that guards every earlier snapshot.
	const resourceRollbackScope = state.rollbackSnapshots.scope();
	return {
		plan: {
			...installStage,
			openClawWorkspaceRoot,
			plannedRuntimePrograms,
			mutationPlan,
			workspaceExistedBeforeApply,
			liveSnapshot,
			resourceRollbackScope,
		},
	};
}

function prepareRuntimeApplyDependencies(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	plan: RuntimeConvergencePlan,
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
	hostedRuntimeContract.assertPlatformRoots();
	// SUNSET: remove after the whole fleet has converged on receipt-free channel state.
	rmSync(join(paths.managedResourceRoot, "whatsapp-auth"), { recursive: true, force: true });
	// Runtime-user targets and their ancestor metadata are already in the
	// exact pre-image snapshot. Establish their positive ownership boundary
	// before any official installer or CLI command drops privilege. Modes are
	// intentionally preserved, so private runtime state stays private.
	enforceRuntimeUserOwnership(plan.mutationPlan.runtimeUserOwnership);
	ensureFileBrowserCompanion(manifest, paths, opts.fileBrowserInstallOptions);
	const openClawObservation = state.observations.get("openclaw");
	if (openClawObservation) {
		try {
			ensureHostedOpenClawProviderAuthCapability({
				manifest,
				secretValues,
				context: openClawContext,
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
	if (managedOpenClawObservation && openClawContext.managedApiKeyProjection) {
		openClawContext.agentDirs.managed =
			discoverOpenClawManagedProviderAuthAgentDirs(openClawContext);
		const supplementalTargets = openClawContext.agentDirs.managed.filter(
			(path) => !plan.liveSnapshot.entries.has(path),
		);
		if (supplementalTargets.length > 0) {
			const supplementalSnapshot = captureRuntimeLiveSnapshot({
				rootTargets: [],
				trustedRootDirectories: [],
				runtimeUserTargets: supplementalTargets,
				runtimeUserTrustedRoots: [paths.userHome, paths.clawdiHome],
				runtimeUserSymlinkTargets: [],
				metadataTargets: [],
			});
			for (const [path, node] of supplementalSnapshot.entries) {
				if (!plan.liveSnapshot.entries.has(path)) plan.liveSnapshot.entries.set(path, node);
			}
			enforceRuntimeUserOwnership(runtimeUserExistingOwnership(supplementalTargets));
		}
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

	hostedRuntimeContract.assertPlatformRoots();
	let codexCli: Record<string, string> | null = null;
	if (
		hostedCodexManagedProvider(manifest) ||
		manifest.projection?.sourceSchemaVersion === "clawdi.hosted-runtime.manifest.v1"
	) {
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

	hostedRuntimeContract.assertPlatformRoots();
	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(paths.userHome));
	ensureRuntimeUserCliStateRoot(paths.clawdiHome, hostedRuntimeContract.identity);
	withRuntimeUserFileAccess(() => {
		mkdirSync(workspaceRoot, { recursive: true });
		makeRuntimeUserOwned(workspaceRoot);
	});
	ensureRuntimePlatformDirectory(paths, paths.managedSecretRoot);
	makeManagedSecretRoot(paths.managedSecretRoot);
	ensureRuntimePlatformDirectory(paths, paths.egressRoot, { mode: 0o711 });
	chmodSync(paths.egressRoot, 0o711);
	makeEgressIdentityPrivateDir(paths.egressCaDir);
	ensureRuntimePlatformDirectory(paths, dirname(paths.egressSystemCaFile), { mode: 0o711 });
	chmodSync(dirname(paths.egressSystemCaFile), 0o711);
	enforceRuntimeUserOwnership(
		runtimeUserDirectoryOwnership(paths.egressScratchRoot, { mode: 0o700 }),
	);
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
		applyContext,
		projectionHome,
		workspaceRoot,
		generatedAt,
		egressProfileBundle,
		appliedState,
	} = context;
	const egressProfileBundlePath = hasEnabledEgressProfiles(egressProfileBundle)
		? writeEgressProfileBundle(egressProfileBundle, paths)
		: clearEgressProfileBundle(paths);
	const egressEngine = egressProfileBundlePath
		? ensureRuntimeMitmproxy(manifest.egressEngine, paths, opts.egressEngineEnsureOptions)
		: null;
	requireV2EgressEngineReady(manifest, egressProfileBundlePath, egressEngine);
	const egressAddon = egressProfileBundlePath ? writeEgressAddon(paths) : clearEgressAddon(paths);
	const daemonAuthTokenFile = writeDaemonAuthToken(paths, secretValues);
	const runtimeAuthToken = daemonAuthTokenFile ? readRuntimeAuthToken(paths) : null;
	if (runtimeAuthToken) {
		state.desiredDaemonAuthTokenRevision = daemonAuthTokenRevision(runtimeAuthToken);
		state.desiredDaemonProgramRevision = daemonProgramRevision(manifest);
		state.restartDaemon =
			state.desiredDaemonAuthTokenRevision !== appliedState?.daemonAuthTokenRevision ||
			state.desiredDaemonProgramRevision !== appliedState?.daemonProgramRevision;
	}
	try {
		withRuntimeUserFileAccess(() =>
			materializeHostedChannelCredentials(manifest, secretValues, projectionHome),
		);
	} catch (error) {
		state.installErrors.push(
			`runtime channel credential materialization failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const egressSecretWrite = writeEgressSecretFile(manifest, secretValues, paths);
	const egressSecretFile = egressSecretWrite.path;
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	const resolvedSystemdIdentity = resolveRuntimeSystemdIdentity({
		paths,
		profileBundlePath: egressProfileBundlePath,
		secretFilePath: egressSecretFile,
		engine: egressEngine,
		addon: egressAddon,
		runtimeUser,
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
	const liveSyncEnvironments = writeLiveSyncEnvironmentFiles(manifest, paths);
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
	const egressSidecarActive =
		egressSystemdProgram !== null &&
		egressIdentity !== null &&
		state.runtimeSystemdUserPrograms.length > 0;
	const committedEgressSidecarSecretRevision = appliedState?.egressSidecarSecretRevision;
	if (egressSidecarActive) {
		state.desiredEgressSidecarSecretRevision = egressSecretWrite.material.revision;
		state.restartEgressSidecar =
			egressSecretWrite.changed ||
			committedEgressSidecarSecretRevision === undefined ||
			committedEgressSidecarSecretRevision !== state.desiredEgressSidecarSecretRevision;
		if (committedEgressSidecarSecretRevision === undefined) {
			// Legacy applied state has no private egress revision. An exact
			// applied content identity can still prove complete last-good material
			// for rollback, but its absence must not block loading the desired
			// material. If desired activation later fails, unverified live bytes
			// must never be loaded by a rollback restart.
			state.rollbackEgressSecretOverride =
				verifiedCommittedEgressSecretMaterial(paths, applyContext) ?? undefined;
			state.egressRollbackAuthorityVerified = state.rollbackEgressSecretOverride !== undefined;
		} else if (
			state.restartEgressSidecar &&
			egressSecretWrite.previousRevision !== committedEgressSidecarSecretRevision
		) {
			if (state.desiredEgressSidecarSecretRevision === committedEgressSidecarSecretRevision) {
				state.rollbackEgressSecretOverride = egressSecretWrite.material;
			} else {
				// A crash may have already advanced both the live file and last-good
				// cache while the applied authority still describes the loaded secret.
				// Do not require rollback material until activation actually fails:
				// successfully restarting the desired material can safely commit it.
				state.rollbackEgressSecretRevision = committedEgressSidecarSecretRevision;
			}
		}
	}
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
		const codexProjection = withRuntimeUserFileAccess(() =>
			applyHostedCodexManagedProviderProjection(manifest, projectionHome, codexCli),
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
		let skillProjectionScope: ReturnType<typeof state.rollbackSnapshots.captureScoped> | null =
			null;
		try {
			const skillMutationTargets = hostedSkillMutationTargets(
				manifest,
				projectionHome,
				plan.openClawWorkspaceRoot,
			);
			skillProjectionScope = state.rollbackSnapshots.captureScoped(
				"runtime Skill filesystem rollback failed",
				{
					rootTargets: [managedSkillReservationLedgerPath()],
					trustedRootDirectories: [paths.managedResourceRoot],
					runtimeUserTargets: skillMutationTargets,
					runtimeUserTrustedRoots: [paths.userHome, paths.clawdiHome],
					runtimeUserSymlinkTargets: [],
					metadataTargets: mutationAncestorMetadataTargets(skillMutationTargets, [
						paths.userHome,
						paths.clawdiHome,
					]),
				},
			);
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
			const projectionError = error instanceof Error ? error.message : String(error);
			const rollbackErrors = skillProjectionScope
				? state.rollbackSnapshots.restore(skillProjectionScope, (_failure, rollbackError) =>
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
					)
				: [];
			if (rollbackErrors.length > 0) {
				throw new Error(
					`runtime Skill projection failed and could not be rolled back: ${projectionError}; ${rollbackErrors.join("; ")}`,
				);
			}
			state.resourceProjectionErrors.push(projectionError);
		}
	}
	try {
		applyHostedMcpProjections(manifest, paths, state.observations, workspaceRoot);
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
		workspaceRoot,
		generatedAt,
		previousProjectedProviderIds,
		runtimeEntries,
		hostedRuntimeContract,
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
		try {
			const localeFile = applyHostedRuntimeConfigProjection(
				name,
				observation,
				manifest,
				projectionHome,
				plan.openClawWorkspaceRoot,
				workspaceRoot,
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
			const channelConfigChanged = applyHostedChannelProjection(
				name,
				observation,
				manifest,
				projectionHome,
				openClawContext,
				workspaceRoot,
				hermesWhatsAppAuthDir,
			);
			if (channelConfigChanged) state.runtimeProjectionMutationRuntimes.add(name);
		} catch (error) {
			state.installErrors.push(
				`runtime ${name} channel projection failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		if (state.installErrors.length > 0) throw new Error(state.installErrors.join("; "));
		const resolved = resolveRuntimeRunConfigs({
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
	hostedRuntimeContract.assertPlatformRoots();
}

interface RuntimeActivationPlan {
	systemdUnits: ReturnType<typeof writeRuntimeSystemdState>;
	officialServicePlan: ReturnType<typeof planOfficialRuntimeServices>;
}

function prepareRuntimeActivation(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	egressProjection: RuntimeEgressProjection,
	providerProjectionRevisions: Partial<Record<string, string | null>>,
): RuntimeActivationPlan {
	const {
		manifest,
		paths,
		opts,
		platformEnclaves,
		secretValues,
		projectionHome,
		hermesWhatsAppAuthDir,
		workspaceRoot,
	} = context;
	const systemdUnits = writeRuntimeSystemdState({
		runtimePrograms: state.runtimeSystemdUserPrograms,
		egressProgram: egressProjection.egressSystemdProgram,
		egressIdentity: egressProjection.egressIdentity,
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
	});
	if (platformEnclaves.some((enclave) => enclave.path === paths.systemdUserRoot)) {
		// Candidate files are written under the root service's private umask.
		// Publish manager-readable modes before a native installer can reload or
		// start its unit for the first time.
		enforceRuntimeUserSystemdManagerAccess(paths.systemdUserRoot);
	}
	state.staleSystemdFiles = systemdUnits.staleFiles;
	const officialServicePlan = planOfficialRuntimeServices(
		state.runtimeSystemdUserPrograms,
		paths,
		opts.systemdApply !== undefined || opts.executeOfficialServiceInstallers === true,
		context.appliedState?.officialServiceCommandRevisions ?? {},
	);
	const pendingOfficialUnits = new Set(officialServicePlan.pending.map((item) => item.unitName));
	state.runtimeProjectionRestartUserUnits = [
		...new Set(
			state.runtimeSystemdUserPrograms
				.filter(
					(program) =>
						program.programKind === "runtime" &&
						program.service === null &&
						state.runtimeProjectionMutationRuntimes.has(program.runtime),
				)
				.map(runtimeSystemdUserUnitName),
		),
	]
		.filter((unitName) => !pendingOfficialUnits.has(unitName))
		.sort();
	// Agent Plugin mutations must precede every native service installer.
	// The final activation below restarts the affected runtime units.
	const appliedAgentPluginTransaction = state.agentPluginTransaction;
	if (appliedAgentPluginTransaction?.hasMutations) {
		const affectedUserUnits = planRuntimeMutationSystemdUserUnits({
			runtimePrograms: state.runtimeSystemdUserPrograms,
			staleUserUnits: state.staleSystemdFiles.userUnits,
			mutationRuntimes: appliedAgentPluginTransaction.mutationRuntimes,
		});
		state.agentPluginQuiesceUserUnits = affectedUserUnits.quiesceUserUnits;
		state.agentPluginRestartUserUnits = affectedUserUnits.restartUserUnits;
		state.agentPluginQuiesceAttempted = true;
		opts.systemdApply?.quiesce(state.agentPluginQuiesceUserUnits);
		state.agentPluginUnitsQuiesced = true;
		state.agentPluginMutationAttempted = true;
	}
	let agentPluginApplyCompleted = false;
	let agentPluginSnapshotScope: ReturnType<typeof state.rollbackSnapshots.captureScoped> | null =
		null;
	try {
		if (appliedAgentPluginTransaction) {
			agentPluginSnapshotScope = state.rollbackSnapshots.captureScoped(
				"runtime Agent Plugin filesystem rollback failed",
				{
					rootTargets: [hostedAgentPluginReceiptsPath(paths)],
					trustedRootDirectories: [paths.statusRoot],
					runtimeUserTargets: [...appliedAgentPluginTransaction.snapshotTargets],
					runtimeUserTrustedRoots: [projectionHome],
					runtimeUserSymlinkTargets: [],
					metadataTargets: mutationAncestorMetadataTargets(
						appliedAgentPluginTransaction.snapshotTargets,
						[projectionHome],
					),
				},
			);
		}
		if (appliedAgentPluginTransaction) {
			const receipt = appliedAgentPluginTransaction.apply();
			agentPluginApplyCompleted = true;
			writeHostedAgentPluginReceipt(receipt, paths);
		}
	} catch (error) {
		const failedNames = agentPluginApplyCompleted
			? opts.preparedHostedAgentPlugins?.desired.keys()
			: appliedAgentPluginTransaction?.mutationNames;
		for (const name of failedNames ?? []) state.agentPluginFailedNames.add(name);
		const rollbackErrors = agentPluginSnapshotScope
			? state.rollbackSnapshots.restore(
					agentPluginSnapshotScope,
					(_failure, rollbackError) =>
						`runtime Agent Plugin snapshot rollback failed: ${
							rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
						}`,
				)
			: [];
		if (rollbackErrors.length > 0) {
			throw new Error(
				`runtime Agent Plugin projection failed and could not be rolled back: ${[
					error instanceof Error ? error.message : String(error),
					...rollbackErrors,
				].join("; ")}`,
			);
		}
		state.resourceProjectionErrors.push(
			`runtime Agent Plugin projection failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		state.agentPluginTransaction = null;
		state.agentPluginMutationAttempted = false;
	}
	return { systemdUnits, officialServicePlan };
}

interface RuntimeActivationOutputs {
	manifestLastGood: string | null;
}

function activateRuntimeServices(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	plan: RuntimeConvergencePlan,
	activationPlan: RuntimeActivationPlan,
): RuntimeActivationOutputs {
	const { load, manifest, paths, opts, hostedRuntimeContract, platformEnclaves } = context;
	const { officialServicePlan, systemdUnits } = activationPlan;
	if (
		officialServicePlan.pending.length > 0 &&
		systemdUnits.egressSidecarActive &&
		opts.systemdApply
	) {
		state.agentPluginUnitsQuiesced = false;
		const prerequisite = opts.systemdApply.activateEgressPrerequisite({
			restartDaemon: state.restartDaemon,
			restartEgressSidecar: state.restartEgressSidecar,
			stopEgressSidecar: false,
			reconcileUserUnits: plan.mutationPlan.systemdUserUnits,
			reloadUserUnits: [],
			restartUserUnits: [],
			staleSystemUnits: [],
			staleUserUnits: [],
		});
		if (!prerequisite.applied) {
			throw new Error("transparent-egress system prerequisites did not reach readiness");
		}
	}

	if (officialServicePlan.pending.length > 0) state.agentPluginUnitsQuiesced = false;
	for (const item of officialServicePlan.pending) {
		hostedRuntimeContract.assertPlatformRoots();
		const unitPath = join(paths.systemdUserRoot, item.unitName);
		const installerOwnership = [
			...runtimeUserDirectoryOwnership(paths.systemdUserRoot),
			...runtimeUserExistingOwnership([
				unitPath,
				`${unitPath}.bak`,
				...(item.program.runtime === "openclaw"
					? [join(paths.userHome, ".openclaw", "gateway.systemd.env")]
					: []),
			]),
		];
		let error: string | null;
		try {
			enforceRuntimeUserOwnership(installerOwnership);
			const install = () => installOfficialRuntimeService(item, paths);
			error = opts.systemdApply
				? opts.systemdApply.installOfficialService(item.unitName, install)
				: install();
		} finally {
			enforceRuntimeUserSystemdManagerAccess(paths.systemdUserRoot);
			enforceRuntimeUserOwnership(runtimePlatformEnclaveOwnership(platformEnclaves));
		}
		if (error) throw new Error(error);
		if (!item.commandRevision) {
			throw new Error(`official ${item.unitName} command revision could not be verified`);
		}
		officialServicePlan.commandRevisions[item.unitName] = item.commandRevision;
	}
	state.officialServiceCommandRevisions = officialServicePlan.commandRevisions;
	if (platformEnclaves.some((enclave) => enclave.path === paths.systemdUserRoot)) {
		enforceRuntimeUserSystemdManagerAccess(paths.systemdUserRoot);
	}
	enforceRuntimeUserOwnership(runtimePlatformEnclaveOwnership(platformEnclaves));
	if (opts.systemdApply) {
		state.agentPluginUnitsQuiesced = false;
		const activation = opts.systemdApply.activate({
			restartDaemon: state.restartDaemon,
			restartEgressSidecar: state.restartEgressSidecar,
			stopEgressSidecar: false,
			reconcileUserUnits: plan.mutationPlan.systemdUserUnits,
			reloadUserUnits: systemdUnits.userEnablementChangedUnits,
			restartUserUnits: [
				...new Set([
					...state.agentPluginRestartUserUnits,
					...state.runtimeProjectionRestartUserUnits,
				]),
			].sort(),
			staleSystemUnits: state.staleSystemdFiles.systemUnits,
			staleUserUnits: state.staleSystemdFiles.userUnits,
		});
		state.systemdActivationApplied = activation.applied;
		if (!activation.applied) {
			throw new Error("systemd runtime services did not reach required readiness");
		}
		probeFileBrowserReadiness(manifest, { probe: opts.fileBrowserReadinessProbe });
	}
	let manifestLastGood: string | null = null;
	if (state.installErrors.length === 0 && opts.cacheLastGood !== false) {
		manifestLastGood = writeLastGoodManifest(
			load.sourceManifest ?? manifest,
			paths,
			load.secretValues,
			manifest,
		);
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
	plan: RuntimeConvergencePlan,
	egressProjection: RuntimeEgressProjection,
	activationPlan: RuntimeActivationPlan,
	convergence: RuntimeConvergenceResult,
): void {
	const { manifest, paths, opts, hostedRuntimeContract, workspaceRoot, appliedState } = context;
	if (state.installErrors.length > 0) return;
	hostedRuntimeContract.assertPlatformRoots();
	const daemonAuthTokenRevisionPreviouslyCommitted =
		state.desiredDaemonAuthTokenRevision !== undefined &&
		state.desiredDaemonAuthTokenRevision === appliedState?.daemonAuthTokenRevision;
	const daemonProgramRevisionPreviouslyCommitted =
		state.desiredDaemonProgramRevision !== undefined &&
		state.desiredDaemonProgramRevision === appliedState?.daemonProgramRevision;
	const egressRevisionPreviouslyCommitted =
		state.desiredEgressSidecarSecretRevision !== undefined &&
		state.desiredEgressSidecarSecretRevision === appliedState?.egressSidecarSecretRevision;
	opts.commitAuthority?.(convergence, {
		...(state.desiredDaemonAuthTokenRevision !== undefined &&
		(state.systemdActivationApplied || daemonAuthTokenRevisionPreviouslyCommitted)
			? { daemonAuthTokenRevision: state.desiredDaemonAuthTokenRevision }
			: {}),
		...(state.desiredDaemonProgramRevision !== undefined &&
		(state.systemdActivationApplied || daemonProgramRevisionPreviouslyCommitted)
			? { daemonProgramRevision: state.desiredDaemonProgramRevision }
			: {}),
		...(state.desiredEgressSidecarSecretRevision !== undefined &&
		(state.systemdActivationApplied || egressRevisionPreviouslyCommitted)
			? { egressSidecarSecretRevision: state.desiredEgressSidecarSecretRevision }
			: {}),
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
		for (const cleanupError of removeStaleRuntimeSystemdFiles(
			paths,
			activationPlan.systemdUnits.staleFiles,
		)) {
			console.warn(`post-commit systemd file cleanup deferred: ${cleanupError}`);
		}
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
		unitNames: plan.mutationPlan.staleOfficialUnits,
		workspaceRoot,
	})) {
		console.warn(`post-commit official runtime service cleanup deferred: ${cleanupError}`);
	}
}

function rollbackRuntimeApply(
	context: RuntimeConvergenceContext,
	state: RuntimeConvergenceState,
	plan: RuntimeConvergencePlan,
	error: unknown,
): RuntimeConvergenceResult {
	const { paths, opts, applyContext, hostedRuntimeContract, workspaceRoot } = context;
	if (state.agentPluginMutationAttempted) {
		for (const name of state.agentPluginTransaction?.mutationNames ?? []) {
			state.agentPluginFailedNames.add(name);
		}
	}
	const applyError = error instanceof Error ? error.message : String(error);
	const systemdMutated = opts.systemdApply?.transactionState() === "mutated";
	const rollbackRequiresQuiesce =
		systemdMutated || state.agentPluginQuiesceAttempted || state.agentPluginMutationAttempted;
	let candidateQuiesced = state.agentPluginUnitsQuiesced || !rollbackRequiresQuiesce;
	if (rollbackRequiresQuiesce && !candidateQuiesced) {
		try {
			opts.systemdApply?.quiesce(state.agentPluginQuiesceUserUnits);
			candidateQuiesced = true;
		} catch (quiesceError) {
			state.installErrors.push(
				`runtime candidate service quiesce failed: ${
					quiesceError instanceof Error ? quiesceError.message : String(quiesceError)
				}`,
			);
		}
	}
	let filesystemRollbackSucceeded = false;
	if (candidateQuiesced) {
		const resourceSnapshotRollbackErrors = state.rollbackSnapshots.restore(
			plan.resourceRollbackScope,
		);
		state.installErrors.push(...resourceSnapshotRollbackErrors);
		try {
			hostedRuntimeContract.assertPlatformRoots();
			const snapshotRollbackErrors = state.rollbackSnapshots.restore();
			state.installErrors.push(...snapshotRollbackErrors);
			if (state.rollbackEgressSecretOverride) {
				writeEgressSecretMaterial(state.rollbackEgressSecretOverride, paths);
			} else if (state.rollbackEgressSecretRevision) {
				const committedMaterial = verifiedCommittedEgressSecretMaterial(paths, applyContext);
				if (committedMaterial?.revision === state.rollbackEgressSecretRevision) {
					writeEgressSecretMaterial(committedMaterial, paths);
				} else {
					state.egressRollbackAuthorityVerified = false;
					rmSync(egressSecretFilePath(paths), { force: true });
				}
			} else if (!state.egressRollbackAuthorityVerified) {
				rmSync(egressSecretFilePath(paths), { force: true });
			}
			filesystemRollbackSucceeded =
				resourceSnapshotRollbackErrors.length === 0 && snapshotRollbackErrors.length === 0;
		} catch (rollbackError) {
			state.installErrors.push(
				`runtime filesystem rollback failed: ${
					rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
				}`,
			);
		}
	} else {
		state.installErrors.push(
			"runtime filesystem rollback skipped because candidate services did not quiesce",
		);
	}
	if (
		filesystemRollbackSucceeded &&
		!plan.workspaceExistedBeforeApply &&
		resolve(workspaceRoot) !== resolve(paths.userHome) &&
		withRuntimeUserFileAccess(() => existsSync(workspaceRoot))
	) {
		try {
			withRuntimeUserFileAccess(() => {
				if (readdirSync(workspaceRoot).length === 0) {
					rmSync(workspaceRoot, { recursive: true });
				}
			});
		} catch (rollbackError) {
			state.installErrors.push(
				`runtime workspace rollback failed: ${
					rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
				}`,
			);
		}
	}
	if (opts.systemdApply && filesystemRollbackSucceeded && rollbackRequiresQuiesce) {
		try {
			opts.systemdApply.rollback({
				restartDaemon: state.restartDaemon,
				restartEgressSidecar: state.restartEgressSidecar && state.egressRollbackAuthorityVerified,
				stopEgressSidecar: state.restartEgressSidecar && !state.egressRollbackAuthorityVerified,
				reconcileUserUnits: plan.mutationPlan.systemdUserUnits,
				reloadUserUnits: [],
				restartUserUnits: [
					...new Set([
						...state.agentPluginRestartUserUnits,
						...state.runtimeProjectionRestartUserUnits,
					]),
				].sort(),
				staleSystemUnits: state.staleSystemdFiles.systemUnits,
				staleUserUnits: state.staleSystemdFiles.userUnits,
			});
		} catch (rollbackError) {
			state.installErrors.push(
				`runtime systemd rollback failed: ${
					rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
				}`,
			);
		}
	} else if (opts.systemdApply && rollbackRequiresQuiesce && candidateQuiesced) {
		state.installErrors.push(
			"runtime systemd rollback skipped because filesystem authority restoration failed",
		);
	} else if (opts.systemdApply && rollbackRequiresQuiesce) {
		state.installErrors.push(
			"runtime systemd reconciliation skipped because candidate services did not quiesce",
		);
	}
	if (!state.egressRollbackAuthorityVerified) {
		state.installErrors.push(
			"runtime egress sidecar stopped because committed secret rollback authority could not be verified",
		);
	}
	state.installErrors.unshift(`runtime apply failed: ${applyError}`);
	return runtimeConvergenceFailure(context, state, true);
}

export function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: RuntimeConvergenceOptions = {},
): RuntimeConvergenceResult {
	const { context, state } = initializeRuntimeConvergence(load, paths, opts);
	const installResult = prepareRuntimeInstallStage(context, state);
	if ("result" in installResult) return installResult.result;
	const planResult = prepareRuntimeConvergencePlan(context, state, installResult.stage);
	if ("result" in planResult) return planResult.result;
	const plan = planResult.plan;
	try {
		const codexCli = prepareRuntimeApplyDependencies(context, state, plan);
		const egressProjection = prepareRuntimeEgressProjection(context, state);
		const providerProjectionRevisions = applyRuntimeResourceProjections(
			context,
			state,
			plan,
			codexCli,
		);

		applyRuntimeEntryProjections(context, state, plan, egressProjection);
		const activationPlan = prepareRuntimeActivation(
			context,
			state,
			egressProjection,
			providerProjectionRevisions,
		);
		const activationOutputs = activateRuntimeServices(context, state, plan, activationPlan);
		const convergence = buildRuntimeConvergenceResult(
			context,
			state,
			egressProjection,
			activationPlan,
			activationOutputs,
		);
		commitRuntimeConvergence(context, state, plan, egressProjection, activationPlan, convergence);
		state.rollbackSnapshots.pop();
		return convergence;
	} catch (error) {
		return rollbackRuntimeApply(context, state, plan, error);
	}
}
