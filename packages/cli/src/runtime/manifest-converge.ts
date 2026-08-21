import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readRuntimeAppliedState } from "./applied-state";
import { RUNTIME_AUTH_TOKEN_SECRET_REF, readRuntimeAuthToken } from "./auth-token";
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
import { hostedHermesSkillExactSourceDriver } from "./hosted-hermes-skill";
import {
	createOpenClawHostedContext,
	hostedOpenClawRuntimeUserOwnership,
} from "./hosted-openclaw-context";
import { hostedOpenClawSkillDriver } from "./hosted-openclaw-skill";
import { assertHostedRuntimeContract } from "./hosted-runtime-contract";
import { type RuntimeInstallReceipts, readRuntimeInstallReceipts } from "./install-receipts";
import {
	captureRuntimeLiveSnapshot,
	type RuntimeLiveSnapshot,
	restoreRuntimeLiveSnapshot,
} from "./live-state-snapshot";
import { reconcileManagedBaileysCompatibility } from "./managed-baileys-compat";
import { managedHermesWhatsAppAuthDir } from "./managed-channel-reconciliation";
import { managedSkillReservationLedgerPath } from "./managed-skill-reservation";
import {
	applyHostedChannelProjection,
	installHostedChannelProjectionDependencies,
	materializeHostedChannelCredentials,
	RETIRED_MANAGED_HERMES_WHATSAPP_RECEIPT,
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
	writeEgressEngineStatus,
	writeEgressProfileBundle,
	writeTransparentEgressEnvFile,
} from "./manifest-egress";
import {
	commitRuntimeInstallReceipts,
	observeRuntimeInstall,
	planRuntimeInstallObservation,
	type RuntimeInstallObservation,
	type RuntimeInstallReceiptTargets,
	runtimeColdInstallMutationPlan,
	runtimeCommandPath,
} from "./manifest-install";
import { applyHostedMcpProjections, hostedMcpProjectionDeclared } from "./manifest-mcp";
import {
	discoverOpenClawManagedProviderAuthAgentDirs,
	ensureHostedOpenClawProviderAuthCapability,
	openClawSupportsOwnerBrowserBootstrap,
	reconcileHostedRuntimeOAuthCredentials,
} from "./manifest-oauth";
import {
	excludeRuntimeSnapshotCoverage,
	hostedSkillMutationTargets,
	managedOpenClawPluginBootstrapMutationPlan,
	managedWhatsAppCompatibilityRuntime,
	planHostedAgentPluginConvergence,
	planRuntimeSystemdUserPrograms,
	type RuntimeConvergenceOptions,
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
	writeProviderHealthStatus,
} from "./manifest-providers";
import { applyHostedRuntimeConfigProjection, projectionPayload } from "./manifest-runtime-config";
import {
	daemonAuthTokenRevision,
	removeLegacyTenantClawdiState,
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
import {
	mutationAncestorMetadataTargets,
	type RuntimeConvergenceResult,
	writeJsonFile,
	writeRuntimePrivateFileAtomic,
} from "./manifest-shared";
import {
	migrateLegacyHostedSkillReceipts,
	reconcileHostedSkillProjection,
} from "./manifest-skills-apply";
import type { RuntimeManifestLoad } from "./manifest-source";
import { ensureRuntimeMitmproxy } from "./mitmproxy-fetch";
import { ensureManagedOpenClawProviderPlugin } from "./openclaw-managed-provider-plugin";
import type { RuntimePaths } from "./paths";
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
	executableExists,
	makeRuntimeUserOwned,
	runtimeUserDirectoryOwnership,
	runtimeUserExistingOwnership,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
import { runtimeSecretValue } from "./secret-values";
import { ensureRuntimePlatformDirectory } from "./state";

export function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: RuntimeConvergenceOptions = {},
): RuntimeConvergenceResult {
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
	// Platform metadata must leave tenant HOME before the recursive ownership
	// invariant is repaired. Both operations precede snapshots by design.
	migrateLegacyHostedSkillReceipts({
		manifest,
		home: projectionHome,
		managedResourceRoot: paths.managedResourceRoot,
	});
	enforceRuntimeUserOwnership([
		...runtimeUserDirectoryOwnership(projectionHome, { recursive: true }),
		...hostedOpenClawRuntimeUserOwnership(manifest, projectionHome),
	]);
	const openClawContext = createOpenClawHostedContext(manifest, projectionHome);
	const hermesWhatsAppAuthDir = managedHermesWhatsAppAuthDir(manifest, projectionHome);
	removeHostedCliPathExposure(paths);
	removeLegacyTenantClawdiState(paths);
	if (manifest.companions?.filebrowser) {
		if (manifest.projection?.sourceBundleVersion !== HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION) {
			throw new Error("Files companion requires a hosted v2 bundle");
		}
		if (!opts.systemdApply) {
			throw new Error("Files companion requires systemd apply and readiness hooks");
		}
	}
	const workspaceRoot = runtimeWorkspaceRoot(manifest, paths);
	let agentPluginTransaction: HostedAgentPluginTransaction | null = null;
	const agentPluginFailedNames = new Set<string>();
	let agentPluginSnapshot: RuntimeLiveSnapshot | null = null;
	let skillProjectionSnapshot: RuntimeLiveSnapshot | null = null;
	let agentPluginQuiesceAttempted = false;
	let agentPluginUnitsQuiesced = false;
	let agentPluginMutationAttempted = false;
	let agentPluginQuiesceUserUnits: string[] = [];
	let agentPluginRestartUserUnits: string[] = [];
	const runtimeProjectionMutationRuntimes = new Set<string>();
	let runtimeProjectionRestartUserUnits: string[] = [];
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
	const instanceRoot = join(paths.instanceRoot, manifest.instanceId);
	const installInventory: string[] = [];
	const projections: string[] = [];
	const managedLocaleFiles: string[] = [];
	const runConfigs: string[] = [];
	const runtimeSystemdUserPrograms: RuntimeSystemdUserProgram[] = [];
	const installErrors: string[] = [];
	const resourceProjectionErrors: string[] = [];
	const appliedState = readRuntimeAppliedState(paths);
	let previousInstallReceipts: RuntimeInstallReceipts | null = null;
	const installReceiptTargets: RuntimeInstallReceiptTargets = {
		officialServices: new Map(),
		channelPlugins: new Map(),
		companions: new Map(),
	};
	const previousProjectedProviderIds = appliedState?.projectedProviderIds ?? {};
	const retainPreviousProjectedProviderIds = () =>
		Object.fromEntries(
			Object.entries(previousProjectedProviderIds).map(([runtime, providerIds]) => [
				runtime,
				[...providerIds],
			]),
		);
	const projectedProviderIds: Record<string, string[]> = {};
	const runtimeEntries = Object.entries(manifest.runtimes).sort(([a], [b]) => a.localeCompare(b));
	const observations = new Map<string, RuntimeInstallObservation>();
	let openClawOwnerBrowserBootstrapSupported = false;

	const preparedHostedSourcedSkills = opts.preparedHostedSourcedSkills ?? new Map();
	const sourcedSkillsPrepared = opts.resourcePreparationFailures?.sourcedSkills === undefined;
	if (opts.resourcePreparationFailures?.sourcedSkills) {
		resourceProjectionErrors.push(opts.resourcePreparationFailures.sourcedSkills);
	}
	if (opts.resourcePreparationFailures?.agentPlugins) {
		resourceProjectionErrors.push(opts.resourcePreparationFailures.agentPlugins.error);
		for (const name of opts.resourcePreparationFailures.agentPlugins.installationNames) {
			agentPluginFailedNames.add(name);
		}
	}
	const hermesSkillNativeReconciler =
		opts.hostedHermesSkillExactSourceDriver ?? hostedHermesSkillExactSourceDriver;
	const openClawSkillDriver = opts.hostedOpenClawSkillDriver ?? hostedOpenClawSkillDriver;
	for (const [name, runtime] of runtimeEntries) {
		const observation = planRuntimeInstallObservation(name, runtime, projectionHome);
		observations.set(name, observation);
		if (observation.error) installErrors.push(observation.error);
	}
	if (installErrors.length > 0) {
		return runtimeConvergenceWithoutApply({
			load,
			paths,
			workspaceRoot,
			enabledRuntimes,
			installErrors,
			projectedProviderIds: retainPreviousProjectedProviderIds(),
		});
	}
	try {
		previousInstallReceipts = readRuntimeInstallReceipts(paths);
	} catch (error) {
		installErrors.push(error instanceof Error ? error.message : String(error));
		return runtimeConvergenceWithoutApply({
			load,
			paths,
			workspaceRoot,
			enabledRuntimes,
			installErrors,
			projectedProviderIds: retainPreviousProjectedProviderIds(),
		});
	}

	const coldInstallPlan = runtimeColdInstallMutationPlan(manifest, paths, observations);
	const rollbackSnapshots = new RuntimeSnapshotRollbackStack();
	if (coldInstallPlan) {
		rollbackSnapshots.capture("runtime installer rollback failed", coldInstallPlan.snapshot);
	}
	const pluginBootstrapPlan = managedOpenClawPluginBootstrapMutationPlan(openClawContext, paths);
	const rollbackInstallFailure = (error: unknown): RuntimeConvergenceResult => {
		installErrors.push(...rollbackSnapshots.restore());
		const message = error instanceof Error ? error.message : String(error);
		if (!installErrors.includes(message)) installErrors.unshift(message);
		return runtimeConvergenceWithoutApply({
			load,
			paths,
			workspaceRoot,
			enabledRuntimes,
			installErrors,
			projectedProviderIds: retainPreviousProjectedProviderIds(),
		});
	};
	try {
		if (coldInstallPlan) {
			hostedRuntimeContract.assertPlatformRoots();
			enforceRuntimeUserOwnership(coldInstallPlan.runtimeUserOwnership);
		}
		for (const [name, runtime] of runtimeEntries) {
			const observation = observeRuntimeInstall(name, runtime, projectionHome);
			observations.set(name, observation);
			if (observation.error) installErrors.push(observation.error);
			if (name === "openclaw") openClawContext.refreshSdkExports(observation);
			if (name === "openclaw" && observation.enabled && observation.commandPath) {
				openClawOwnerBrowserBootstrapSupported =
					openClawSupportsOwnerBrowserBootstrap(openClawContext);
			}
		}
		if (installErrors.length > 0) throw new Error(installErrors.join("; "));
		if (pluginBootstrapPlan) {
			rollbackSnapshots.capture(
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
		return rollbackInstallFailure(error);
	}

	let openClawWorkspaceRoot: string | null;
	let plannedRuntimePrograms: RuntimeSystemdUserProgram[];
	let mutationPlan: ReturnType<typeof runtimeManagedMutationPlan>;
	try {
		const openClawCommand = runtimeCommandPath("openclaw", projectionHome);
		const shouldResolveOpenClawWorkspace =
			manifest.runtimes.openclaw?.enabled === true ||
			Boolean(openClawCommand && executableExists(openClawCommand));
		openClawWorkspaceRoot = shouldResolveOpenClawWorkspace
			? openClawSkillDriver.resolveWorkspace({
					home: projectionHome,
					repairInvalidConfig:
						manifest.projection?.sourceBundleVersion === HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION,
				})
			: null;
		validateRuntimeProjectionPlan({
			manifest,
			paths,
			openClawWorkspaceRoot,
			secretValues,
			observations,
			previousProjectedProviderIds,
			hermesWhatsAppAuthDir,
			openClawOwnerBrowserBootstrapSupported,
		});
		plannedRuntimePrograms = planRuntimeSystemdUserPrograms({
			manifest,
			paths,
			workspaceRoot,
			generatedAt,
			secretValues,
			observations,
			egressProfileBundlePath: plannedEgressProfileBundlePath,
			egress: null,
		});
		validateRuntimeSystemdPlan(plannedRuntimePrograms);
		mutationPlan = runtimeManagedMutationPlan({
			manifest,
			paths,
			openClawWorkspaceRoot,
			openClawContext,
			programs: plannedRuntimePrograms,
			observations,
		});
	} catch (error) {
		throw rollbackSnapshots.failure(error);
	}
	if (pluginBootstrapPlan) {
		try {
			const observation = observations.get("openclaw");
			if (!observation?.commandPath) {
				throw new Error("OpenClaw managed provider plugin requires an installed runtime");
			}
			ensureManagedOpenClawProviderPlugin({
				context: openClawContext,
				commandPath: observation.commandPath,
			});
		} catch (error) {
			return rollbackInstallFailure(error);
		}
	}
	if (mutationPlan.systemdDriftErrors.length > 0) {
		installErrors.push(...rollbackSnapshots.restore());
		installErrors.push(...mutationPlan.systemdDriftErrors);
		return runtimeConvergenceWithoutApply({
			load,
			paths,
			workspaceRoot,
			enabledRuntimes,
			installErrors,
			projectedProviderIds: retainPreviousProjectedProviderIds(),
		});
	}
	const workspaceExistedBeforeApply = withRuntimeUserFileAccess(() => existsSync(workspaceRoot));
	let liveSnapshot: ReturnType<typeof captureRuntimeLiveSnapshot>;
	try {
		let snapshotPlan = mutationPlan.snapshot;
		if (coldInstallPlan) {
			snapshotPlan = excludeRuntimeSnapshotCoverage(snapshotPlan, coldInstallPlan.snapshot);
		}
		if (pluginBootstrapPlan) {
			snapshotPlan = excludeRuntimeSnapshotCoverage(snapshotPlan, pluginBootstrapPlan);
		}
		liveSnapshot = rollbackSnapshots.capture("runtime filesystem rollback failed", snapshotPlan);
	} catch (error) {
		throw rollbackSnapshots.failure(error);
	}
	let systemdActivationApplied = false;
	let restartDaemon = false;
	let desiredDaemonAuthTokenRevision: string | undefined;
	let desiredDaemonProgramRevision: string | undefined;
	let restartEgressSidecar = false;
	let desiredEgressSidecarSecretRevision: string | undefined;
	let rollbackEgressSecretOverride: RuntimeEgressSecretMaterial | undefined;
	let rollbackEgressSecretRevision: string | undefined;
	let egressRollbackAuthorityVerified = true;
	let staleSystemdFiles: RuntimeSystemdStaleFilePlan = {
		files: [],
		systemUnits: [],
		userUnits: [],
	};
	try {
		hostedRuntimeContract.assertPlatformRoots();
		// Runtime-user targets and their ancestor metadata are already in the
		// exact pre-image snapshot. Establish their positive ownership boundary
		// before any official installer or CLI command drops privilege. Modes are
		// intentionally preserved, so private runtime state stays private.
		enforceRuntimeUserOwnership(mutationPlan.runtimeUserOwnership);
		const fileBrowserInstall = ensureFileBrowserCompanion(
			manifest,
			paths,
			previousInstallReceipts?.companions.filebrowser,
			opts.fileBrowserInstallOptions,
		);
		if (fileBrowserInstall) {
			installReceiptTargets.companions.set(
				fileBrowserInstall.receiptKey,
				fileBrowserInstall.receiptTarget,
			);
		}
		const openClawObservation = observations.get("openclaw");
		if (openClawObservation) {
			try {
				ensureHostedOpenClawProviderAuthCapability({
					manifest,
					secretValues,
					context: openClawContext,
				});
			} catch (error) {
				installErrors.push(
					`runtime openclaw credential capability check failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		if (installErrors.length > 0) throw new Error(installErrors.join("; "));
		const managedOpenClawObservation = observations.get("openclaw");
		if (managedOpenClawObservation && openClawContext.managedApiKeyProjection) {
			openClawContext.agentDirs.managed =
				discoverOpenClawManagedProviderAuthAgentDirs(openClawContext);
			const supplementalTargets = openClawContext.agentDirs.managed.filter(
				(path) => !liveSnapshot.entries.has(path),
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
					if (!liveSnapshot.entries.has(path)) liveSnapshot.entries.set(path, node);
				}
				enforceRuntimeUserOwnership(runtimeUserExistingOwnership(supplementalTargets));
			}
		}
		if (
			openClawWorkspaceRoot &&
			resolve(openClawSkillDriver.resolveWorkspace({ home: projectionHome })) !==
				resolve(openClawWorkspaceRoot)
		) {
			throw new Error("OpenClaw official agent workspace changed during runtime reconciliation");
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
					agentPluginFailedNames.add(name);
				}
				resourceProjectionErrors.push(
					`runtime Agent Plugin projection planning failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				planned = { transaction: null };
			}
			agentPluginTransaction = planned.transaction;
			if (agentPluginTransaction?.hasMutations && !opts.systemdApply) {
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
				installErrors.push(
					`runtime codex setup failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		for (const [name] of runtimeEntries) {
			const observation = observations.get(name);
			if (!observation) throw new Error(`runtime ${name} install observation is missing`);
			try {
				installHostedChannelProjectionDependencies(
					name,
					observation,
					manifest,
					projectionHome,
					paths.userHome,
					previousInstallReceipts,
					installReceiptTargets,
				);
			} catch (error) {
				installErrors.push(
					`runtime ${name} channel plugin install failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		const managedWhatsAppRuntime = managedWhatsAppCompatibilityRuntime(manifest);
		try {
			const observation = managedWhatsAppRuntime
				? observations.get(managedWhatsAppRuntime)
				: undefined;
			if (managedWhatsAppRuntime && !observation?.appRoot) {
				throw new Error(`runtime ${managedWhatsAppRuntime} artifact root is unavailable`);
			}
			const compatibility = reconcileManagedBaileysCompatibility({
				desiredRuntime: managedWhatsAppRuntime,
				home: projectionHome,
				...(observation?.appRoot ? { appRoot: observation.appRoot } : {}),
				paths,
			});
			if (compatibility.status === "rollback-refused") {
				throw new Error(compatibility.errors.join(", "));
			}
		} catch (error) {
			const operation = managedWhatsAppRuntime
				? `runtime ${managedWhatsAppRuntime} managed WhatsApp compatibility`
				: "runtime managed WhatsApp compatibility cleanup";
			installErrors.push(
				`${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (installErrors.length > 0) throw new Error(installErrors.join("; "));

		hostedRuntimeContract.assertPlatformRoots();
		enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(paths.userHome));
		ensureRuntimeUserCliStateRoot(paths.clawdiHome, hostedRuntimeContract.identity);
		withRuntimeUserFileAccess(() => {
			mkdirSync(workspaceRoot, { recursive: true });
			makeRuntimeUserOwned(workspaceRoot);
		});
		for (const directory of [paths.installInventory, paths.projectionRoot, instanceRoot]) {
			ensureRuntimePlatformDirectory(paths, directory, { mode: 0o755 });
		}
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

		let manifestLastGood: string | null = null;
		writeJsonFile(
			paths.managedConfig,
			{
				schemaVersion: "clawdi.hostedManagedConfig.v1",
				generatedAt,
				deploymentId: manifest.deploymentId,
				environmentId: manifest.environmentId,
				instanceId: manifest.instanceId,
				generation: manifest.generation,
				locale: manifest.locale ?? null,
				controlPlane: manifest.controlPlane,
				egressEngine: manifest.egressEngine ?? null,
				auth: {
					source: "runtime-instance-data",
					token: "<redacted>",
				},
				workspaceRoot,
			},
			paths,
		);
		writeJsonFile(
			paths.syncState,
			{
				schemaVersion: "clawdi.runtimeSyncState.v1",
				generatedAt,
				deploymentId: manifest.deploymentId,
				environmentId: manifest.environmentId,
				instanceId: manifest.instanceId,
				generation: manifest.generation,
				locale: manifest.locale ?? null,
				runtimes: Object.fromEntries(
					Object.entries(manifest.runtimes).map(([name, runtime]) => [
						name,
						{
							enabled: runtime.enabled,
							updateChannel: runtime.updateChannel ?? null,
							workspaceRoot,
						},
					]),
				),
			},
			paths,
		);
		writeJsonFile(
			paths.instanceData,
			{
				schemaVersion: "clawdi.runtimeInstanceData.v1",
				generatedAt,
				deploymentId: manifest.deploymentId,
				environmentId: manifest.environmentId,
				instanceId: manifest.instanceId,
				generation: manifest.generation,
				locale: manifest.locale ?? null,
				controlPlane: manifest.controlPlane,
				workspaceRoot,
			},
			paths,
		);
		writeJsonFile(
			paths.sensitiveInstanceData,
			{
				schemaVersion: "clawdi.runtimeSensitiveInstanceData.v1",
				generatedAt,
				tokenSource: runtimeSecretValue(secretValues ?? {}, RUNTIME_AUTH_TOKEN_SECRET_REF)
					? "CLAWDI_AUTH_TOKEN"
					: load.source,
				token: "<redacted>",
			},
			paths,
		);

		const egressProfileBundlePath = hasEnabledEgressProfiles(egressProfileBundle)
			? writeEgressProfileBundle(egressProfileBundle, paths)
			: clearEgressProfileBundle(paths);
		const egressEngine = writeEgressEngineStatus(
			egressProfileBundlePath
				? ensureRuntimeMitmproxy(manifest.egressEngine, paths, opts.egressEngineEnsureOptions)
				: null,
			paths,
		);
		requireV2EgressEngineReady(manifest, egressProfileBundlePath, egressEngine);
		const egressAddon = egressProfileBundlePath ? writeEgressAddon(paths) : clearEgressAddon(paths);
		const daemonAuthTokenFile = writeDaemonAuthToken(paths, secretValues);
		const runtimeAuthToken = daemonAuthTokenFile ? readRuntimeAuthToken(paths) : null;
		if (runtimeAuthToken) {
			desiredDaemonAuthTokenRevision = daemonAuthTokenRevision(runtimeAuthToken);
			desiredDaemonProgramRevision = daemonProgramRevision(manifest);
			restartDaemon =
				desiredDaemonAuthTokenRevision !== appliedState?.daemonAuthTokenRevision ||
				desiredDaemonProgramRevision !== appliedState?.daemonProgramRevision;
		}
		try {
			withRuntimeUserFileAccess(() =>
				materializeHostedChannelCredentials(manifest, secretValues, projectionHome),
			);
		} catch (error) {
			installErrors.push(
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
		writeProviderHealthStatus(manifest, load.secretValues, paths);
		const liveSyncEnvironments = writeLiveSyncEnvironmentFiles(manifest, paths);
		const writtenRunConfigIds = new Set<string>();
		runtimeSystemdUserPrograms.push(
			...planRuntimeSystemdUserPrograms({
				manifest,
				paths,
				workspaceRoot,
				generatedAt,
				secretValues,
				observations,
				egressProfileBundlePath,
				egress: egressSystemdProgram,
			}),
		);
		const egressSidecarActive =
			egressSystemdProgram !== null &&
			egressIdentity !== null &&
			runtimeSystemdUserPrograms.length > 0;
		const committedEgressSidecarSecretRevision = appliedState?.egressSidecarSecretRevision;
		if (egressSidecarActive) {
			desiredEgressSidecarSecretRevision = egressSecretWrite.material.revision;
			restartEgressSidecar =
				egressSecretWrite.changed ||
				committedEgressSidecarSecretRevision === undefined ||
				committedEgressSidecarSecretRevision !== desiredEgressSidecarSecretRevision;
			if (committedEgressSidecarSecretRevision === undefined) {
				// Legacy applied state has no private egress revision. An exact
				// applied content identity can still prove complete last-good material
				// for rollback, but its absence must not block loading the desired
				// material. If desired activation later fails, unverified live bytes
				// must never be loaded by a rollback restart.
				rollbackEgressSecretOverride =
					verifiedCommittedEgressSecretMaterial(paths, applyContext) ?? undefined;
				egressRollbackAuthorityVerified = rollbackEgressSecretOverride !== undefined;
			} else if (
				restartEgressSidecar &&
				egressSecretWrite.previousRevision !== committedEgressSidecarSecretRevision
			) {
				if (desiredEgressSidecarSecretRevision === committedEgressSidecarSecretRevision) {
					rollbackEgressSecretOverride = egressSecretWrite.material;
				} else {
					// A crash may have already advanced both the live file and last-good
					// cache while the applied authority still describes the loaded secret.
					// Do not require rollback material until activation actually fails:
					// successfully restarting the desired material can safely commit it.
					rollbackEgressSecretRevision = committedEgressSidecarSecretRevision;
				}
			}
		}
		const commonSystemdEnvironment = runtimeSystemdCommonEnvironment(paths);

		validateRuntimeProjectionPlan({
			manifest,
			paths,
			openClawWorkspaceRoot,
			secretValues,
			observations,
			previousProjectedProviderIds,
			hermesWhatsAppAuthDir,
			openClawOwnerBrowserBootstrapSupported,
		});
		const providerProjectionRevisions: Partial<Record<string, string | null>> = {};
		for (const [name] of runtimeEntries) {
			const observation = observations.get(name);
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
			projectedProviderIds.codex = codexProjection.providerIds;
		} catch (error) {
			installErrors.push(
				`runtime codex provider projection failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		if (installErrors.length > 0) {
			throw new Error(installErrors.join("; "));
		}
		if (sourcedSkillsPrepared) {
			try {
				const skillMutationTargets = hostedSkillMutationTargets(
					manifest,
					projectionHome,
					openClawWorkspaceRoot,
					paths.managedResourceRoot,
				);
				skillProjectionSnapshot = captureRuntimeLiveSnapshot({
					rootTargets: [
						managedSkillReservationLedgerPath(),
						...skillMutationTargets.platformTargets,
					],
					trustedRootDirectories: [paths.managedResourceRoot],
					runtimeUserTargets: skillMutationTargets.runtimeUserTargets,
					runtimeUserTrustedRoots: [paths.userHome, paths.clawdiHome],
					runtimeUserSymlinkTargets: [],
					metadataTargets: mutationAncestorMetadataTargets(
						skillMutationTargets.runtimeUserTargets,
						[paths.userHome, paths.clawdiHome],
					),
				});
				resourceProjectionErrors.push(
					...reconcileHostedSkillProjection({
						manifest,
						observations,
						home: projectionHome,
						managedResourceRoot: paths.managedResourceRoot,
						openClawWorkspaceRoot,
						preparedSourcedSkills: preparedHostedSourcedSkills,
						hermesDriver: hermesSkillNativeReconciler,
						openClawDriver: openClawSkillDriver,
					}),
				);
			} catch (error) {
				const projectionError = error instanceof Error ? error.message : String(error);
				try {
					if (skillProjectionSnapshot) restoreRuntimeLiveSnapshot(skillProjectionSnapshot);
				} catch (rollbackError) {
					throw new Error(
						`runtime Skill projection failed and could not be rolled back: ${projectionError}; ${
							rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
						}`,
					);
				}
				skillProjectionSnapshot = null;
				resourceProjectionErrors.push(projectionError);
			}
		}
		try {
			applyHostedMcpProjections(manifest, paths, observations, workspaceRoot);
		} catch (error) {
			installErrors.push(
				`runtime MCP projection failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (installErrors.length > 0) {
			throw new Error(installErrors.join("; "));
		}

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
				installErrors.push(
					`stale ${runtime} OAuth credential reconciliation failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		if (installErrors.length > 0) {
			throw new Error(installErrors.join("; "));
		}

		for (const [name, runtime] of runtimeEntries) {
			const observation = observations.get(name);
			if (!observation) throw new Error(`runtime ${name} install observation is missing`);

			const inventoryPath = join(paths.installInventory, `${name}.json`);
			writeJsonFile(
				inventoryPath,
				{
					schemaVersion: "clawdi.runtimeInstallInventory.v1",
					generatedAt,
					runtime: name,
					enabled: runtime.enabled,
					updateChannel: runtime.updateChannel ?? null,
					simulation: false,
					status: observation.status,
					executionUser: observation.executionUser,
					install: observation.install,
					installerArgs: runtime.install?.args ?? [],
					commandPath: observation.commandPath,
					appRoot: observation.appRoot,
					installerUrl: observation.installerUrl,
					executedInstallerUrl: observation.executedInstallerUrl,
					installStartedAt: observation.installStartedAt ?? null,
					installFinishedAt: observation.installFinishedAt ?? null,
					installDurationMs: observation.installDurationMs ?? null,
					resultExitCode: observation.exitCode,
					stdoutTail: observation.stdoutTail,
					stderrTail: observation.stderrTail,
					error: observation.error,
				},
				paths,
			);
			installInventory.push(inventoryPath);

			const projectionPath = join(paths.projectionRoot, `${name}.json`);
			writeJsonFile(projectionPath, projectionPayload(name, manifest), paths);
			projections.push(projectionPath);
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
					installErrors.push(
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
					openClawWorkspaceRoot,
					workspaceRoot,
				);
				if (localeFile) managedLocaleFiles.push(localeFile);
			} catch (error) {
				installErrors.push(
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
					openClawOwnerBrowserBootstrapSupported,
				);
				projectedProviderIds[name] = providerProjection.providerIds;
			} catch (error) {
				installErrors.push(
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
				if (channelConfigChanged) runtimeProjectionMutationRuntimes.add(name);
			} catch (error) {
				installErrors.push(
					`runtime ${name} channel projection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			if (installErrors.length > 0) {
				throw new Error(installErrors.join("; "));
			}
			const resolved = resolveRuntimeRunConfigs({
				manifest,
				paths,
				name,
				runtime,
				observation,
				workspaceRoot,
				generatedAt,
				secretValues,
				egressProfileBundlePath,
			});
			const runConfigPath = writeRuntimeRunConfig(resolved.runtime, paths);
			runConfigs.push(runConfigPath);
			writtenRunConfigIds.add(runtimeRunConfigId(resolved.runtime.runtime));
			for (const serviceRunConfig of resolved.services) {
				const serviceRunConfigPath = writeRuntimeRunConfig(serviceRunConfig, paths);
				runConfigs.push(serviceRunConfigPath);
				writtenRunConfigIds.add(
					runtimeRunConfigId(serviceRunConfig.runtime, serviceRunConfig.service),
				);
			}
		}

		const mcpProjection = join(paths.projectionRoot, "clawdi-mcp.json");
		if (hostedMcpProjectionDeclared(manifest) || manifest.projection?.skills !== undefined) {
			writeJsonFile(mcpProjection, projectionPayload("clawdi-mcp", manifest), paths);
			projections.push(mcpProjection);
		} else {
			rmSync(mcpProjection, { force: true });
		}
		hostedRuntimeContract.assertPlatformRoots();
		const systemdUnits = writeRuntimeSystemdState({
			runtimePrograms: runtimeSystemdUserPrograms,
			egressProgram: egressSystemdProgram,
			egressIdentity,
			manifest,
			paths,
			workspaceRoot,
			daemonAuthTokenFile,
			secretValues,
			providerProjectionRevisions,
			runtimeRevision: (desired, runtime, secrets, providerRevision) =>
				runtimeProgramRevisionForManifest(
					desired,
					runtime,
					secrets,
					providerRevision,
					hermesWhatsAppAuthDir,
					openClawOwnerBrowserBootstrapSupported,
				),
			commonEnvironment: commonSystemdEnvironment,
		});
		staleSystemdFiles = systemdUnits.staleFiles;
		const officialServicePlan = planOfficialRuntimeServices(
			runtimeSystemdUserPrograms,
			paths,
			previousInstallReceipts,
			opts.systemdApply !== undefined || opts.executeOfficialServiceInstallers === true,
		);
		const pendingOfficialUnits = new Set(officialServicePlan.pending.map((item) => item.unitName));
		runtimeProjectionRestartUserUnits = [
			...new Set(
				runtimeSystemdUserPrograms
					.filter(
						(program) =>
							program.programKind === "runtime" &&
							program.service === null &&
							runtimeProjectionMutationRuntimes.has(program.runtime),
					)
					.map(runtimeSystemdUserUnitName),
			),
		]
			.filter((unitName) => !pendingOfficialUnits.has(unitName))
			.sort();
		installReceiptTargets.officialServices = officialServicePlan.targets;
		// Agent Plugin mutations must precede every native service installer.
		// The final activation below restarts the affected runtime units.
		const appliedAgentPluginTransaction = agentPluginTransaction;
		if (appliedAgentPluginTransaction?.hasMutations) {
			const affectedUserUnits = planRuntimeMutationSystemdUserUnits({
				runtimePrograms: runtimeSystemdUserPrograms,
				staleUserUnits: staleSystemdFiles.userUnits,
				mutationRuntimes: appliedAgentPluginTransaction.mutationRuntimes,
			});
			agentPluginQuiesceUserUnits = affectedUserUnits.quiesceUserUnits;
			agentPluginRestartUserUnits = affectedUserUnits.restartUserUnits;
			agentPluginQuiesceAttempted = true;
			opts.systemdApply?.quiesce(agentPluginQuiesceUserUnits);
			agentPluginUnitsQuiesced = true;
			agentPluginMutationAttempted = true;
		}
		let agentPluginApplyCompleted = false;
		try {
			if (appliedAgentPluginTransaction) {
				agentPluginSnapshot = captureRuntimeLiveSnapshot({
					rootTargets: [hostedAgentPluginReceiptsPath(paths)],
					trustedRootDirectories: [paths.statusRoot],
					runtimeUserTargets: [...appliedAgentPluginTransaction.snapshotTargets],
					runtimeUserTrustedRoots: [projectionHome],
					runtimeUserSymlinkTargets: [],
					metadataTargets: mutationAncestorMetadataTargets(
						appliedAgentPluginTransaction.snapshotTargets,
						[projectionHome],
					),
				});
			}
			appliedAgentPluginTransaction?.apply();
			agentPluginApplyCompleted = true;
			if (appliedAgentPluginTransaction) {
				writeHostedAgentPluginReceipt(appliedAgentPluginTransaction.nextReceipt, paths);
			}
		} catch (error) {
			const failedNames = agentPluginApplyCompleted
				? opts.preparedHostedAgentPlugins?.desired.keys()
				: appliedAgentPluginTransaction?.mutationNames;
			for (const name of failedNames ?? []) {
				agentPluginFailedNames.add(name);
			}
			const rollbackErrors = appliedAgentPluginTransaction?.rollback() ?? [];
			try {
				if (agentPluginSnapshot) restoreRuntimeLiveSnapshot(agentPluginSnapshot);
			} catch (rollbackError) {
				rollbackErrors.push(
					`runtime Agent Plugin snapshot rollback failed: ${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
			if (rollbackErrors.length > 0) {
				throw new Error(
					`runtime Agent Plugin projection failed and could not be rolled back: ${[
						error instanceof Error ? error.message : String(error),
						...rollbackErrors,
					].join("; ")}`,
				);
			}
			resourceProjectionErrors.push(
				`runtime Agent Plugin projection failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			agentPluginTransaction = null;
			agentPluginSnapshot = null;
			agentPluginMutationAttempted = false;
		}
		if (
			officialServicePlan.pending.length > 0 &&
			systemdUnits.egressSidecarActive &&
			opts.systemdApply
		) {
			agentPluginUnitsQuiesced = false;
			const prerequisite = opts.systemdApply.activateEgressPrerequisite({
				restartDaemon,
				restartEgressSidecar,
				stopEgressSidecar: false,
				reconcileUserUnits: mutationPlan.systemdUserUnits,
				restartUserUnits: [],
				staleSystemUnits: [],
				staleUserUnits: [],
			});
			if (!prerequisite.applied) {
				throw new Error("transparent-egress system prerequisites did not reach readiness");
			}
		}

		if (officialServicePlan.pending.length > 0) agentPluginUnitsQuiesced = false;
		for (const item of officialServicePlan.pending) {
			hostedRuntimeContract.assertPlatformRoots();
			const install = () => installOfficialRuntimeService(item, paths);
			const error = opts.systemdApply
				? opts.systemdApply.installOfficialService(item.unitName, install)
				: install();
			if (error) throw new Error(error);
		}
		hostedRuntimeContract.assertPlatformRoots();
		const bootFinished = join(instanceRoot, "boot-finished");
		writeRuntimePrivateFileAtomic(paths, bootFinished, `${generatedAt}\n`);
		if (opts.systemdApply) {
			agentPluginUnitsQuiesced = false;
			const activation = opts.systemdApply.activate({
				restartDaemon,
				restartEgressSidecar,
				stopEgressSidecar: false,
				reconcileUserUnits: mutationPlan.systemdUserUnits,
				restartUserUnits: [
					...new Set([...agentPluginRestartUserUnits, ...runtimeProjectionRestartUserUnits]),
				].sort(),
				staleSystemUnits: staleSystemdFiles.systemUnits,
				staleUserUnits: staleSystemdFiles.userUnits,
			});
			systemdActivationApplied = activation.applied;
			if (!activation.applied) {
				throw new Error("systemd runtime services did not reach required readiness");
			}
			probeFileBrowserReadiness(manifest, { probe: opts.fileBrowserReadinessProbe });
		}
		if (installErrors.length === 0 && opts.cacheLastGood !== false) {
			manifestLastGood = writeLastGoodManifest(
				load.sourceManifest ?? manifest,
				paths,
				load.secretValues,
				manifest,
			);
		}

		const convergence: RuntimeConvergenceResult = {
			manifest,
			source: load.source,
			sourcePath: load.sourcePath,
			offline: load.offline,
			mode: load.offline ? "degraded-offline" : "normal",
			enabledRuntimes,
			installErrors,
			resourceProjectionErrors,
			projectedProviderIds,
			agentPluginFailedNames: [...agentPluginFailedNames].sort(),
			outputs: {
				processManager: "systemd",
				workspaceRoot,
				managedConfig: paths.managedConfig,
				syncState: paths.syncState,
				instanceData: paths.instanceData,
				sensitiveInstanceData: paths.sensitiveInstanceData,
				manifestLastGood,
				appliedState: null,
				installInventory,
				projections,
				managedLocaleFiles,
				runConfigs,
				systemdSystemUnitRoot: paths.systemdSystemRoot,
				systemdSystemUnits: systemdUnits.systemUnits,
				systemdUserUnitRoot: paths.systemdUserRoot,
				systemdUserUnits: systemdUnits.userUnits,
				egressProfileBundle: egressProfileBundlePath,
				egressSecretFile,
				egressEngine,
				egressTransparentEnv,
				egressAddon: egressAddon?.path ?? null,
				liveSyncEnvironments,
				daemonAuthTokenFile,
				bootFinished,
			},
		};
		if (installErrors.length === 0) {
			hostedRuntimeContract.assertPlatformRoots();
			const daemonAuthTokenRevisionPreviouslyCommitted =
				desiredDaemonAuthTokenRevision !== undefined &&
				desiredDaemonAuthTokenRevision === appliedState?.daemonAuthTokenRevision;
			const daemonProgramRevisionPreviouslyCommitted =
				desiredDaemonProgramRevision !== undefined &&
				desiredDaemonProgramRevision === appliedState?.daemonProgramRevision;
			const egressRevisionPreviouslyCommitted =
				desiredEgressSidecarSecretRevision !== undefined &&
				desiredEgressSidecarSecretRevision === appliedState?.egressSidecarSecretRevision;
			rmSync(join(paths.managedResourceRoot, RETIRED_MANAGED_HERMES_WHATSAPP_RECEIPT), {
				force: true,
			});
			commitRuntimeInstallReceipts(installReceiptTargets, paths);
			opts.commitAuthority?.(convergence, {
				...(desiredDaemonAuthTokenRevision !== undefined &&
				(systemdActivationApplied || daemonAuthTokenRevisionPreviouslyCommitted)
					? { daemonAuthTokenRevision: desiredDaemonAuthTokenRevision }
					: {}),
				...(desiredDaemonProgramRevision !== undefined &&
				(systemdActivationApplied || daemonProgramRevisionPreviouslyCommitted)
					? { daemonProgramRevision: desiredDaemonProgramRevision }
					: {}),
				...(desiredEgressSidecarSecretRevision !== undefined &&
				(systemdActivationApplied || egressRevisionPreviouslyCommitted)
					? { egressSidecarSecretRevision: desiredEgressSidecarSecretRevision }
					: {}),
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
				for (const cleanupError of removeStaleRuntimeSystemdFiles(paths, systemdUnits.staleFiles)) {
					console.warn(`post-commit systemd file cleanup deferred: ${cleanupError}`);
				}
				removeStaleRuntimeRunConfigs(writtenRunConfigIds, paths);
			} catch (cleanupError) {
				console.warn(
					`post-commit runtime file cleanup deferred: ${
						cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
					}`,
				);
			}
			for (const cleanupError of uninstallStaleOfficialRuntimeServices({
				paths,
				unitNames: mutationPlan.staleOfficialUnits,
				workspaceRoot,
			})) {
				console.warn(`post-commit official runtime service cleanup deferred: ${cleanupError}`);
			}
		}
		return convergence;
	} catch (error) {
		if (agentPluginMutationAttempted) {
			for (const name of agentPluginTransaction?.mutationNames ?? []) {
				agentPluginFailedNames.add(name);
			}
		}
		const applyError = error instanceof Error ? error.message : String(error);
		const systemdMutated = opts.systemdApply?.transactionState() === "mutated";
		const rollbackRequiresQuiesce =
			systemdMutated || agentPluginQuiesceAttempted || agentPluginMutationAttempted;
		let candidateQuiesced = agentPluginUnitsQuiesced || !rollbackRequiresQuiesce;
		if (rollbackRequiresQuiesce && !candidateQuiesced) {
			try {
				opts.systemdApply?.quiesce(agentPluginQuiesceUserUnits);
				candidateQuiesced = true;
			} catch (quiesceError) {
				installErrors.push(
					`runtime candidate service quiesce failed: ${
						quiesceError instanceof Error ? quiesceError.message : String(quiesceError)
					}`,
				);
			}
		}
		let filesystemRollbackSucceeded = false;
		if (candidateQuiesced) {
			if (agentPluginTransaction) installErrors.push(...agentPluginTransaction.rollback());
			let resourceFilesystemRollbackSucceeded = true;
			if (agentPluginSnapshot) {
				try {
					restoreRuntimeLiveSnapshot(agentPluginSnapshot);
				} catch (rollbackError) {
					resourceFilesystemRollbackSucceeded = false;
					installErrors.push(
						`runtime Agent Plugin filesystem rollback failed: ${
							rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
						}`,
					);
				}
			}
			if (skillProjectionSnapshot) {
				try {
					restoreRuntimeLiveSnapshot(skillProjectionSnapshot);
				} catch (rollbackError) {
					resourceFilesystemRollbackSucceeded = false;
					installErrors.push(
						`runtime Skill filesystem rollback failed: ${
							rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
						}`,
					);
				}
			}
			try {
				hostedRuntimeContract.assertPlatformRoots();
				const snapshotRollbackErrors = rollbackSnapshots.restore();
				installErrors.push(...snapshotRollbackErrors);
				if (rollbackEgressSecretOverride) {
					writeEgressSecretMaterial(rollbackEgressSecretOverride, paths);
				} else if (rollbackEgressSecretRevision) {
					const committedMaterial = verifiedCommittedEgressSecretMaterial(paths, applyContext);
					if (committedMaterial?.revision === rollbackEgressSecretRevision) {
						writeEgressSecretMaterial(committedMaterial, paths);
					} else {
						egressRollbackAuthorityVerified = false;
						rmSync(egressSecretFilePath(paths), { force: true });
					}
				} else if (!egressRollbackAuthorityVerified) {
					rmSync(egressSecretFilePath(paths), { force: true });
				}
				filesystemRollbackSucceeded =
					resourceFilesystemRollbackSucceeded && snapshotRollbackErrors.length === 0;
			} catch (rollbackError) {
				installErrors.push(
					`runtime filesystem rollback failed: ${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
		} else {
			installErrors.push(
				"runtime filesystem rollback skipped because candidate services did not quiesce",
			);
		}
		if (
			filesystemRollbackSucceeded &&
			!workspaceExistedBeforeApply &&
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
				installErrors.push(
					`runtime workspace rollback failed: ${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
		}
		if (opts.systemdApply && filesystemRollbackSucceeded && rollbackRequiresQuiesce) {
			try {
				opts.systemdApply.rollback({
					restartDaemon,
					restartEgressSidecar: restartEgressSidecar && egressRollbackAuthorityVerified,
					stopEgressSidecar: restartEgressSidecar && !egressRollbackAuthorityVerified,
					reconcileUserUnits: mutationPlan.systemdUserUnits,
					restartUserUnits: [
						...new Set([...agentPluginRestartUserUnits, ...runtimeProjectionRestartUserUnits]),
					].sort(),
					staleSystemUnits: staleSystemdFiles.systemUnits,
					staleUserUnits: staleSystemdFiles.userUnits,
				});
			} catch (rollbackError) {
				installErrors.push(
					`runtime systemd rollback failed: ${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
		} else if (opts.systemdApply && rollbackRequiresQuiesce && candidateQuiesced) {
			installErrors.push(
				"runtime systemd rollback skipped because filesystem authority restoration failed",
			);
		} else if (opts.systemdApply && rollbackRequiresQuiesce) {
			installErrors.push(
				"runtime systemd reconciliation skipped because candidate services did not quiesce",
			);
		}
		if (!egressRollbackAuthorityVerified) {
			installErrors.push(
				"runtime egress sidecar stopped because committed secret rollback authority could not be verified",
			);
		}
		installErrors.unshift(`runtime apply failed: ${applyError}`);
		return runtimeConvergenceWithoutApply({
			load,
			paths,
			workspaceRoot,
			enabledRuntimes,
			installErrors,
			projectedProviderIds: retainPreviousProjectedProviderIds(),
			agentPluginFailedNames: [...agentPluginFailedNames].sort(),
		});
	}
}
