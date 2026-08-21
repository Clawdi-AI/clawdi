import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGED_AI_PROVIDER_RUNTIME_ENV } from "@clawdi/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { buildAgentTargetProjection } from "../lib/ai-provider-projection";
import {
	decideChatGptOAuthCredentialReconciliation,
	intentLedgerForDecision,
	type NativeOAuthCredentialObservation,
	type OAuthCredentialLedgerSnapshot,
} from "../lib/chatgpt-oauth-reconciliation";
import {
	HERMES_CODEX_AUTH_HELPER,
	type NativeOAuthCredentialMutationResult,
	nativeOAuthMutationResult,
	nativeOAuthObservation,
	nativeOAuthProfileId,
	type OAuthCredentialOwnership,
	OPENCLAW_CONFIG_MUTATION_EXPORTS,
	OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_HELPER,
	OPENCLAW_PROVIDER_AUTH_CLEANUP_EXPORTS,
	OPENCLAW_PROVIDER_AUTH_HELPER,
	OPENCLAW_PROVIDER_AUTH_MUTATION_EXPORTS,
	OPENCLAW_PROVIDER_ENV_VARS_EXPORTS,
	oauthCredentialFingerprint,
	openClawSdkFunctionGuard,
} from "../lib/codex-oauth-native-store";
import { resolveCurrentCliResourceRoot } from "../lib/current-cli-invocation";
import {
	type OAuthCredentialLedger,
	oauthCredentialLedgerPath,
	oauthCredentialLedgerSnapshot,
	readOAuthCredentialLedger,
	writeOAuthCredentialLedger,
} from "../lib/oauth-credential-ledger";
import { writePrivateFileAtomic } from "../lib/private-file";
import { isValidSemver } from "../lib/semver";
import {
	type RuntimeUserProcessRevisionAliases,
	readRuntimeAppliedState,
	runtimeContentSha256,
} from "./applied-state";
import type { RuntimeApplyContext } from "./apply-identity";
import {
	ensureRuntimeAuthTokenFile,
	RUNTIME_AUTH_TOKEN_SECRET_REF,
	readRuntimeAuthToken,
} from "./auth-token";
import { removeHostedCliPathExposure } from "./cli-update";
import {
	ensureFileBrowserCompanion,
	type FileBrowserCompanionInstallOptions,
	fileBrowserCompanionMutationPlan,
	fileBrowserCompanionProgram,
	gcFileBrowserCompanionCandidates,
	probeFileBrowserReadiness,
} from "./file-browser-companion";
import {
	getHermesRawConfigValue,
	getHermesResolvedConfigValue,
	type HermesConfigCommandContext,
	reconcileHermesConfigValue,
} from "./hermes-config";
import {
	hostedAgentPluginReceiptsPath,
	type PreparedHostedAgentPlugins,
	writeHostedAgentPluginReceipt,
} from "./hosted-agent-plugin-package";
import {
	type HostedAgentPluginCommandRunner,
	type HostedAgentPluginCommands,
	type HostedAgentPluginTransaction,
	hostedAgentPluginCommands,
	prepareHostedAgentPluginTransaction,
	proveHostedAgentPluginCapabilities,
} from "./hosted-agent-plugin-runtime";
import {
	adoptableLegacyHostedBundledSkill,
	hostedBundledSkillIds,
	resolveHostedBundledSkill,
} from "./hosted-bundled-skill";
import { managedMcpHeaderPlaceholder, normalizeSecretRef } from "./hosted-egress-profiles";
import {
	type HostedHermesSkillExactSourceDriver,
	hostedHermesSkillExactSourceDriver,
} from "./hosted-hermes-skill";
import { createOpenClawHostedContext, type OpenClawHostedContext } from "./hosted-openclaw-context";
import { type HostedOpenClawSkillDriver, hostedOpenClawSkillDriver } from "./hosted-openclaw-skill";
import {
	agentTargetProjectionInput,
	type HostedAiProviderProjectionInput,
	hostedAiProviderCatalog,
	hostedProviderEnvironment,
	hostedProviderRequiresApiKey,
	mergeRuntimeEnvWithProviderPlaceholders,
	mergeRuntimeServiceEnvWithProviderPlaceholders,
} from "./hosted-provider-resolution";
import {
	assertHostedRuntimeContract,
	type HostedRuntimeContractOptions,
} from "./hosted-runtime-contract";
import {
	type PreparedHostedSourcedSkill,
	prepareHostedBundledSkillArchive,
} from "./hosted-sourced-skill-archive";
import {
	emptyRuntimeInstallReceipts,
	type RuntimeInstallReceiptEntry,
	type RuntimeInstallReceipts,
	readRuntimeInstallReceipts,
	runtimeInstallReceiptsPath,
	writeRuntimeInstallReceipts,
} from "./install-receipts";
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
	reconcileManagedBaileysCompatibility,
} from "./managed-baileys-compat";
import {
	buildHermesManagedChannelsPatch,
	managedChannelHasAccounts,
	managedHermesWhatsAppAuthDir,
} from "./managed-channel-reconciliation";
import {
	installReservedManagedSkill,
	type ManagedSkillReservationSnapshot,
	managedSkillReservationLedgerPath,
	managedSkillReservationOwner,
	managedSkillReservations,
	releaseManagedSkill,
	reserveManagedSkill,
} from "./managed-skill-reservation";
import {
	AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR,
	AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR,
	HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION,
	hasUnsupportedAgentPluginInstallations,
	isHostedCodexManagedRuntimeEnv,
	type LiveSyncAgent,
	type RuntimeInstall,
	type RuntimeManifest,
} from "./manifest-contract";
import {
	type HostedMcpServerDesiredState,
	type HostedSkillSource,
	hostedMcpDesiredStateSchema,
} from "./manifest-resources";
import { ensureManagedOpenClawProviderPlugin } from "./openclaw-managed-provider-plugin";
import { openClawPluginInspectSchema } from "./openclaw-plugin-observation";
import { normalizeSecretValues, runtimeSecretValue } from "./secret-values";

export type { RuntimeInstall, RuntimeManifest } from "./manifest-contract";
export {
	loadRuntimeManifest,
	type RuntimeManifestFailure,
	type RuntimeManifestLoad,
} from "./manifest-source";

import { MANAGED_EGRESS_PLACEHOLDER_VALUE, SYSTEM_CA_BUNDLE } from "./egress-env";
import {
	buildEgressProfileBundle,
	type EgressProfileBundle,
	egressProfileSecretRefs,
	hasEnabledEgressProfiles,
} from "./egress-profiles";
import {
	loadCommittedRuntimeManifest,
	manifestSecretRefs,
	type RuntimeManifestLoad,
} from "./manifest-source";
import {
	type EnsureRuntimeMitmproxyOptions,
	ensureRuntimeMitmproxy,
	type RuntimeMitmproxyEnsureResult,
} from "./mitmproxy-fetch";
import { detectRuntimeMode, RUNTIME_USER_CLI_STATE_ROOT_MODE, type RuntimePaths } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import {
	buildRuntimeRunConfig,
	isSupportedRuntimeName,
	type RuntimeName,
	type RuntimeRunConfig,
	type RuntimeRunSettings,
	type RuntimeServiceName,
	runtimeNameSchema,
	runtimeRunConfigId,
	runtimeServiceNameSchema,
	writeRuntimeRunConfig,
} from "./run-config";
import {
	daemonProgramRevision,
	runtimeImpactRevision,
	runtimeProgramRevision,
} from "./runtime-impact-revision";
import {
	buildRuntimeSystemdUserProgram,
	installOfficialRuntimeService,
	planOfficialRuntimeServices,
	planRuntimeMutationSystemdUserUnits,
	planRuntimeSystemdUserMutations,
	type RuntimeEgressSystemdProgram,
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
	buildRuntimeUserCommand,
	clearTenantToolLocationOverrides,
	commandExists,
	commandResolvable,
	enforceRuntimeUserOwnership,
	executableExists,
	makeRuntimeUserOwned,
	type RuntimeUserOwnershipRule,
	runningAsRoot,
	runRuntimeUserCommand,
	runtimeEgressGid,
	runtimeEgressUid,
	runtimeUserDirectoryOwnership,
	runtimeUserExistingOwnership,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
import {
	ensureRuntimePlatformDirectory,
	runtimePlatformRootForPath,
	writeRuntimePlatformFileAtomic,
} from "./state";

import {
	TRANSPARENT_EGRESS_TABLE,
	TRANSPARENT_EGRESS_TRANSPORT_VERSION,
} from "./transparent-egress";
import {
	type ManagedWhatsAppAuthCredential,
	managedWhatsAppAuthCredentials,
} from "./whatsapp-credential-projection";
import {
	CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY,
	parseManagedWhatsAppSocketMetadataJson,
} from "./whatsapp-upstream-contract";

export interface RuntimeConvergenceResult {
	manifest: RuntimeManifest;
	source: RuntimeManifestLoad["source"];
	sourcePath: string;
	offline: boolean;
	mode: "normal" | "degraded-offline";
	enabledRuntimes: string[];
	installErrors: string[];
	resourceProjectionErrors: string[];
	projectedProviderIds: Record<string, string[]>;
	agentPluginFailedNames: string[];
	outputs: {
		processManager: "systemd";
		workspaceRoot: string;
		managedConfig: string;
		syncState: string;
		instanceData: string;
		sensitiveInstanceData: string;
		manifestLastGood: string | null;
		appliedState: string | null;
		installInventory: string[];
		projections: string[];
		managedLocaleFiles: string[];
		runConfigs: string[];
		systemdSystemUnitRoot: string;
		systemdSystemUnits: string[];
		systemdUserUnitRoot: string;
		systemdUserUnits: string[];
		egressProfileBundle: string | null;
		egressSecretFile: string | null;
		egressEngine: RuntimeMitmproxyEnsureResult | null;
		egressTransparentEnv: string | null;
		egressAddon: string | null;
		liveSyncEnvironments: string[];
		daemonAuthTokenFile: string | null;
		bootFinished: string;
	};
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

type RuntimeSystemdApplyResult = {
	applied: boolean;
	systemUnitsChanged: string[];
	userUnitsChanged: string[];
};

interface RuntimeSystemdApplySignal {
	// Private, in-memory apply metadata. It must not enter convergence outputs,
	// status, diagnostics, logs, or any generated public artifact.
	restartDaemon: boolean;
	restartEgressSidecar: boolean;
	stopEgressSidecar: boolean;
	reconcileUserUnits: string[];
	restartUserUnits: string[];
	staleSystemUnits: string[];
	staleUserUnits: string[];
}

interface RuntimeSystemdApplyHooks {
	activateEgressPrerequisite: (signal: RuntimeSystemdApplySignal) => RuntimeSystemdApplyResult;
	activate: (signal: RuntimeSystemdApplySignal) => RuntimeSystemdApplyResult;
	transactionState: () => "pristine" | "mutated";
	installOfficialService: (unit: string, install: () => string | null) => string | null;
	quiesce: (affectedUserUnits: readonly string[]) => void;
	rollback: (signal: RuntimeSystemdApplySignal) => void;
}

export interface RuntimePrivateAppliedAuthority {
	// These private activation verifiers may only be persisted in the root-owned
	// 0600 applied-state authority.
	daemonAuthTokenRevision?: string;
	daemonProgramRevision?: string;
	egressSidecarSecretRevision?: string;
	userProcessRevisionAliases?: RuntimeUserProcessRevisionAliases;
}

interface RuntimeInstallObservation {
	runtime: string;
	enabled: boolean;
	status: "disabled" | "present" | "installed" | "configured" | "install_failed";
	executionUser: string | null;
	commandPath: string | null;
	appRoot: string | null;
	install: RuntimeInstall | null;
	installerUrl: string | null;
	executedInstallerUrl: string | null;
	exitCode: number | null;
	installStartedAt?: string;
	installFinishedAt?: string;
	installDurationMs?: number;
	stdoutTail: string | null;
	stderrTail: string | null;
	error: string | null;
}

function runtimeInstallObservation(
	observation: Pick<RuntimeInstallObservation, "runtime" | "enabled" | "status"> &
		Partial<Omit<RuntimeInstallObservation, "runtime" | "enabled" | "status">>,
): RuntimeInstallObservation {
	return {
		executionUser: null,
		commandPath: null,
		appRoot: null,
		install: null,
		installerUrl: null,
		executedInstallerUrl: null,
		exitCode: null,
		stdoutTail: null,
		stderrTail: null,
		error: null,
		...observation,
	};
}

const OPENCLAW_CODEX_PROVIDER_ID = "openai";

interface RuntimeOAuthMaterial {
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	accountId?: string;
	lastRefresh: string;
	expires: number;
}

interface HostedRuntimeOAuthCredential {
	providerId: string;
	profile: string;
	credentialRevision: string;
	material: RuntimeOAuthMaterial;
}

type RuntimeOAuthCredentialAction = "inspect" | "seed-if-missing" | "upsert" | "remove";

interface RuntimeOAuthCredentialCommand {
	action: RuntimeOAuthCredentialAction;
	nativeProfileId: string;
	credentialRevision: string;
	material?: RuntimeOAuthMaterial;
	ownership?: OAuthCredentialOwnership;
	expectedFingerprint?: string;
}

interface RuntimeOAuthCredentialDriver {
	observe: (
		input: Omit<RuntimeOAuthCredentialCommand, "action" | "material" | "expectedFingerprint">,
	) => NativeOAuthCredentialObservation;
	mutate: (
		input: Omit<RuntimeOAuthCredentialCommand, "action"> & {
			action: Exclude<RuntimeOAuthCredentialAction, "inspect">;
		},
	) => NativeOAuthCredentialMutationResult;
}

interface RuntimeInstallReceiptTarget {
	desiredRevision: string;
	currentRevision: () => string | null;
	expectedCurrentRevision: string | null;
}

interface RuntimeInstallReceiptTargets {
	officialServices: Map<string, RuntimeInstallReceiptTarget>;
	channelPlugins: Map<string, RuntimeInstallReceiptTarget>;
	companions: Map<"filebrowser", RuntimeInstallReceiptTarget>;
}

function writeRuntimePrivateFileAtomic(
	paths: RuntimePaths,
	path: string,
	content: string | Uint8Array,
	options: { mode?: number; dirMode?: number } = {},
): void {
	const trustedRoot = runtimePlatformRootForPath(paths, path);
	if (trustedRoot) writeRuntimePlatformFileAtomic(paths, path, content, options);
	else writePrivateFileAtomic(path, content, options);
}

function writeJsonFile(path: string, payload: unknown, paths?: RuntimePaths): void {
	const content = `${JSON.stringify(payload, null, 2)}\n`;
	if (paths) writeRuntimePrivateFileAtomic(paths, path, content);
	else writePrivateFileAtomic(path, content);
}

function writeLastGoodManifest(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	secretValues: Record<string, string> | undefined,
	secretScopeManifest: RuntimeManifest = manifest,
	excludedSecretRefs: readonly string[] = egressSidecarOnlySecretRefs(secretScopeManifest),
): string | null {
	if (manifest.recovery.cacheManifest === false) {
		rmSync(paths.manifestLastGood, { force: true });
		rmSync(paths.managedSecretCacheFile, { force: true });
		return null;
	}
	writeJsonFile(paths.manifestLastGood, manifest, paths);
	writeLastGoodSecretValues(secretScopeManifest, secretValues, paths, excludedSecretRefs);
	return paths.manifestLastGood;
}

export function cacheRuntimeLastGoodManifest(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	secretValues?: Record<string, string>,
): string | null {
	// This runs only with successfully committed authority, so persist the full
	// active consumer union needed for exact offline reconstruction.
	return writeLastGoodManifest(manifest, paths, secretValues, manifest, []);
}

function writeLastGoodSecretValues(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	paths: RuntimePaths,
	excludedRefs: readonly string[] = [],
): void {
	const recoverable = omitSecretRefs(
		runtimeRecoverableSecretValues(manifest, secretValues),
		excludedRefs,
	);
	if (Object.keys(recoverable).length === 0) {
		rmSync(paths.managedSecretCacheFile, { force: true });
		return;
	}
	writeRuntimePrivateFileAtomic(
		paths,
		paths.managedSecretCacheFile,
		`${JSON.stringify(recoverable, null, 2)}\n`,
		{
			mode: 0o600,
			// The parent is the cache platform root; its mode is owned by the
			// systemd CacheDirectory directive, never by this writer.
		},
	);
}

function makeManagedSecretRoot(path: string): void {
	chmodSync(path, 0o711);
}

function omitSecretRefs(
	secretValues: Record<string, string> | undefined,
	excludedRefs: readonly string[],
): Record<string, string> {
	const normalized = normalizeSecretValues(secretValues);
	for (const ref of excludedRefs) delete normalized[ref];
	return normalized;
}

const MANAGED_WHATSAPP_AUTH_MARKER = ".clawdi-managed-whatsapp-auth.json";
// SUNSET: Remove after every fleet host has converged past the retired Hermes WhatsApp receipt writer.
const RETIRED_MANAGED_HERMES_WHATSAPP_RECEIPT = "hermes-whatsapp.json";

export function materializeHostedChannelCredentials(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	home: string,
): void {
	if (!hostedChannelCredentialsDeclared(manifest)) {
		removeStaleManagedWhatsAppAuthDirs(home, new Set<string>());
		return;
	}
	const credentials = hostedWhatsAppAuthCredentials(manifest);
	const normalizedSecrets = normalizeSecretValues(secretValues);
	const expectedAuthDirs = new Set<string>();
	const errors: string[] = [];
	for (const credential of credentials) {
		const authDirError = managedWhatsAppAuthDirError(home, credential);
		if (authDirError) {
			errors.push(authDirError);
			continue;
		}
		expectedAuthDirs.add(resolve(credential.authDir));
		const credsJson = runtimeSecretValue(normalizedSecrets, credential.credsJsonSecretRef);
		if (!credsJson) {
			removeManagedWhatsAppAuthDir(credential.authDir);
			errors.push(
				`missing WhatsApp auth state secret for ${credential.accountKey}/${credential.credentialId}`,
			);
			continue;
		}
		try {
			materializeManagedWhatsAppAuthDir(credential, credsJson, home);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	removeStaleManagedWhatsAppAuthDirs(home, expectedAuthDirs);
	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
}

function validateHostedChannelCredentialsPlan(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	home: string,
): void {
	if (!hostedChannelCredentialsDeclared(manifest)) return;
	const normalizedSecrets = normalizeSecretValues(secretValues);
	for (const credential of hostedWhatsAppAuthCredentials(manifest)) {
		const authDirError = managedWhatsAppAuthDirError(home, credential);
		if (authDirError) throw new Error(authDirError);
		const credsJson = runtimeSecretValue(normalizedSecrets, credential.credsJsonSecretRef);
		if (!credsJson) {
			throw new Error(
				`missing WhatsApp auth state secret for ${credential.accountKey}/${credential.credentialId}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(credsJson);
		} catch (error) {
			throw new Error(
				`invalid WhatsApp auth state JSON for ${credential.accountKey}/${credential.credentialId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const parsedCreds = recordValue(parsed);
		if (!parsedCreds) {
			throw new Error(
				`invalid WhatsApp auth state JSON for ${credential.accountKey}/${credential.credentialId}: creds.json must be a JSON object`,
			);
		}
		assertManagedWhatsAppMetadata(parsedCreds, credential);
		if (existsSync(credential.authDir) && lstatSync(credential.authDir).isSymbolicLink()) {
			throw new Error(
				`refusing to overwrite symlinked WhatsApp auth directory ${credential.authDir}`,
			);
		}
		const existingMarker = readManagedWhatsAppAuthMarker(credential.authDir);
		if (
			existsSync(credential.authDir) &&
			!existingMarker &&
			readdirSync(credential.authDir).length > 0
		) {
			throw new Error(
				`refusing to overwrite unmanaged WhatsApp auth directory ${credential.authDir}`,
			);
		}
	}
}

function hostedChannelCredentialsDeclared(manifest: RuntimeManifest): boolean {
	return Boolean(manifest.projection && Object.hasOwn(manifest.projection, "channelCredentials"));
}

function hostedWhatsAppAuthCredentials(manifest: RuntimeManifest): ManagedWhatsAppAuthCredential[] {
	return managedWhatsAppAuthCredentials(manifest.projection?.channelCredentials);
}

function materializeManagedWhatsAppAuthDir(
	credential: ManagedWhatsAppAuthCredential,
	credsJson: string,
	home: string,
): void {
	let parsedCreds: Record<string, unknown>;
	try {
		const parsed = JSON.parse(credsJson) as unknown;
		const record = recordValue(parsed);
		if (!record) {
			throw new Error("creds.json must be a JSON object");
		}
		parsedCreds = record;
		assertManagedWhatsAppMetadata(parsedCreds, credential);
	} catch (error) {
		removeManagedWhatsAppAuthDir(credential.authDir);
		throw new Error(
			`invalid WhatsApp auth state JSON for ${credential.accountKey}/${credential.credentialId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (existsSync(credential.authDir) && lstatSync(credential.authDir).isSymbolicLink()) {
		throw new Error(
			`refusing to overwrite symlinked WhatsApp auth directory ${credential.authDir}`,
		);
	}
	const existingMarker = readManagedWhatsAppAuthMarker(credential.authDir);
	if (existingMarker && existingMarker.credentialId !== credential.credentialId) {
		rmSync(credential.authDir, { recursive: true, force: true });
	} else if (existsSync(credential.authDir) && !existingMarker) {
		const entries = readdirSync(credential.authDir);
		if (entries.length > 0) {
			throw new Error(
				`refusing to overwrite unmanaged WhatsApp auth directory ${credential.authDir}`,
			);
		}
	}

	enforceRuntimeUserOwnership(
		runtimeUserDirectoryOwnership(credential.authDir, { mode: 0o700, ancestorsUnder: home }),
	);
	writePrivateFileAtomic(
		join(credential.authDir, "creds.json"),
		`${JSON.stringify(parsedCreds, null, 2)}\n`,
		{
			mode: 0o600,
			dirMode: 0o700,
		},
	);
	makeRuntimeUserOwned(join(credential.authDir, "creds.json"));
	writeJsonFile(join(credential.authDir, MANAGED_WHATSAPP_AUTH_MARKER), {
		schemaVersion: "clawdi.managedWhatsAppAuth.v1",
		provider: "whatsapp",
		target: credential.target,
		accountKey: credential.accountKey,
		credentialId: credential.credentialId,
	});
	makeRuntimeUserOwned(join(credential.authDir, MANAGED_WHATSAPP_AUTH_MARKER));
}

function assertManagedWhatsAppMetadata(
	creds: Record<string, unknown>,
	credential: Pick<ManagedWhatsAppAuthCredential, "accountKey" | "credentialId">,
): void {
	const additionalData = recordValue(creds.additionalData);
	try {
		if (
			!additionalData ||
			!Object.hasOwn(additionalData, CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY)
		) {
			throw new Error("metadata is missing");
		}
		parseManagedWhatsAppSocketMetadataJson(
			additionalData[CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY],
		);
	} catch (error) {
		throw new Error(
			`invalid managed WhatsApp metadata for ${credential.accountKey}/${credential.credentialId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function managedWhatsAppAuthDirError(
	home: string,
	credential: ManagedWhatsAppAuthCredential,
): string | null {
	const root = managedWhatsAppAuthRoot(home, credential.target);
	if (!root) return "WhatsApp auth credential projection is missing runtime home";
	const resolvedAuthDir = resolve(credential.authDir);
	if (credential.target === "hermes") {
		return resolvedAuthDir === root ? null : `WhatsApp auth directory must be ${root}`;
	}
	const relativePath = relative(root, resolvedAuthDir);
	if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
		return null;
	}
	return `WhatsApp auth directory must be under ${root}`;
}

function managedWhatsAppAuthRoot(
	home: string,
	target: ManagedWhatsAppAuthCredential["target"],
): string | null {
	if (!home) return null;
	return target === "hermes"
		? resolve(home, ".hermes", "platforms", "whatsapp", "session")
		: resolve(home, ".openclaw", "credentials", "whatsapp");
}

interface ManagedWhatsAppAuthMarker {
	schemaVersion: "clawdi.managedWhatsAppAuth.v1";
	provider: "whatsapp";
	target: ManagedWhatsAppAuthCredential["target"];
	accountKey: string;
	credentialId: string;
}

function readManagedWhatsAppAuthMarker(authDir: string): ManagedWhatsAppAuthMarker | null {
	const markerPath = join(authDir, MANAGED_WHATSAPP_AUTH_MARKER);
	try {
		if (!lstatSync(markerPath).isFile()) return null;
		const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as unknown;
		const record = recordValue(parsed);
		const target = record ? stringValue(record.target) : null;
		const accountKey = record ? stringValue(record.accountKey) : null;
		const credentialId = record ? stringValue(record.credentialId) : null;
		if (
			record?.schemaVersion !== "clawdi.managedWhatsAppAuth.v1" ||
			record.provider !== "whatsapp" ||
			(target !== "openclaw" && target !== "hermes" && target !== "legacy") ||
			!accountKey ||
			!credentialId
		) {
			return null;
		}
		return {
			schemaVersion: "clawdi.managedWhatsAppAuth.v1",
			provider: "whatsapp",
			target,
			accountKey,
			credentialId,
		};
	} catch {
		return null;
	}
}

function removeManagedWhatsAppAuthDir(authDir: string): void {
	if (!readManagedWhatsAppAuthMarker(authDir)) return;
	rmSync(authDir, { recursive: true, force: true });
}

function removeManagedHermesWhatsAppAuthDir(authDir: string): void {
	const marker = readManagedWhatsAppAuthMarker(authDir);
	if (marker?.target !== "hermes") return;
	rmSync(authDir, { recursive: true, force: true });
}

function removeStaleManagedWhatsAppAuthDirs(home: string, expected: Set<string>): void {
	const openclawRoot = managedWhatsAppAuthRoot(home, "openclaw");
	if (openclawRoot && existsSync(openclawRoot)) {
		removeStaleManagedWhatsAppAuthDirsUnderRoot(openclawRoot, expected);
	}
	const hermesAuthDir = managedWhatsAppAuthRoot(home, "hermes");
	if (hermesAuthDir && !expected.has(hermesAuthDir)) {
		removeManagedHermesWhatsAppAuthDir(hermesAuthDir);
	}
}

function removeStaleManagedWhatsAppAuthDirsUnderRoot(root: string, expected: Set<string>): void {
	for (const entry of readdirSync(root)) {
		const authDir = join(root, entry);
		try {
			if (!lstatSync(authDir).isDirectory()) continue;
		} catch {
			continue;
		}
		if (!expected.has(authDir)) {
			removeManagedWhatsAppAuthDir(authDir);
		}
	}
}

function scopedSecretValues(
	secretValues: Record<string, string> | undefined,
	refs: readonly string[],
): Record<string, string> {
	const normalizedValues = normalizeSecretValues(secretValues);
	const scoped: Record<string, string> = {};
	for (const ref of refs) {
		const value = runtimeSecretValue(normalizedValues, ref);
		if (!value) throw new Error(`Runtime secret ${ref} is unavailable.`);
		scoped[ref] = value;
	}
	return scoped;
}

export function runtimeRecoverableSecretValues(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
): Record<string, string> {
	return scopedSecretValues(secretValues, manifestSecretRefs(manifest));
}

function writeProviderHealthStatus(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	paths: RuntimePaths,
): string | null {
	const providers = recordValue(manifest.projection?.providers);
	if (!providers || Object.keys(providers).length === 0) {
		rmSync(paths.providerHealthStatus, { force: true });
		return null;
	}

	const observed: Record<string, unknown> = {};
	for (const providerId of Object.keys(providers).sort()) {
		const provider = recordValue(providers[providerId]);
		if (!provider) continue;
		const apiKeySecretRef = stringValue(provider.apiKeySecretRef);
		const secretAvailable =
			apiKeySecretRef === null
				? null
				: providerSecretAvailable(secretValues ?? {}, apiKeySecretRef);
		const reasons = providerHealthReasons(provider, secretAvailable);
		observed[providerId] = {
			status: reasons.length > 0 ? "error" : "ok",
			configured: true,
			kind: stringValue(provider.kind),
			baseUrl: stringValue(provider.baseUrl),
			model: stringValue(provider.model),
			models: Array.isArray(provider.models) ? provider.models : undefined,
			apiKeySecretRef,
			secretAvailable,
			reasons,
		};
	}

	if (Object.keys(observed).length === 0) {
		rmSync(paths.providerHealthStatus, { force: true });
		return null;
	}
	writeRuntimePrivateFileAtomic(
		paths,
		paths.providerHealthStatus,
		`${JSON.stringify(
			{
				schemaVersion: "clawdi.hostedRuntimeProviderHealth.v1",
				generatedAt: new Date().toISOString(),
				providers: observed,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o644, dirMode: 0o755 },
	);
	return paths.providerHealthStatus;
}

function providerSecretAvailable(secretValues: Record<string, string>, ref: string): boolean {
	return runtimeSecretValue(secretValues, ref) !== null;
}

function providerHealthReasons(
	provider: Record<string, unknown>,
	secretAvailable: boolean | null,
): string[] {
	const reasons: string[] = [];
	const status = stringValue(provider.status);
	if (status && status !== "ok") {
		reasons.push(`provider_${status}`);
	}
	const error = recordValue(provider.error);
	const errorCode = error ? stringValue(error.code) : null;
	if (errorCode) {
		reasons.push(errorCode);
	}
	const baseUrl = stringValue(provider.baseUrl);
	if (!baseUrl) {
		reasons.push("base_url_missing");
	} else {
		try {
			new URL(baseUrl);
		} catch {
			reasons.push("base_url_invalid");
		}
	}
	if (!stringValue(provider.model) && !providerHasModels(provider)) {
		reasons.push("model_missing");
	}
	const apiMode = stringValue(provider.apiMode);
	if (baseUrl && isOpenAiCompatibleMode(apiMode)) {
		try {
			const parsed = new URL(baseUrl);
			if (!parsed.pathname || parsed.pathname === "/") {
				reasons.push("base_url_path_missing");
			}
		} catch {
			// Already reported as base_url_invalid above.
		}
	}
	if (stringValue(provider.apiKeySecretRef) && secretAvailable === false) {
		reasons.push("secret_missing");
	}
	if (hostedProviderRequiresApiKey(provider) && !stringValue(provider.apiKeySecretRef)) {
		reasons.push("api_key_secret_ref_missing");
	}
	return reasons;
}

function providerHasModels(provider: Record<string, unknown>): boolean {
	return (
		Array.isArray(provider.models) &&
		provider.models.some((model) => {
			const entry = recordValue(model);
			return Boolean(entry && stringValue(entry.id));
		})
	);
}

function isOpenAiCompatibleMode(apiMode: string | null): boolean {
	return apiMode === "openai_chat" || apiMode === "openai_responses";
}

function recordValue(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function makeEgressIdentityOwned(path: string): void {
	if (!runningAsRoot()) return;
	const uid = runtimeEgressUid();
	const gid = runtimeEgressGid();
	chownSync(path, uid, gid);
}

function ensureRuntimeUserCliStateRoot(path: string, identity: { uid: number; gid: number }): void {
	mkdirSync(path, { recursive: true });
	let node = lstatSync(path);
	if (!node.isDirectory() || node.isSymbolicLink()) {
		throw new Error(`hosted CLAWDI_HOME must be a real directory: ${path}`);
	}
	if (runningAsRoot()) chownSync(path, identity.uid, identity.gid);
	chmodSync(path, RUNTIME_USER_CLI_STATE_ROOT_MODE);
	node = lstatSync(path);
	if (
		(node.mode & 0o777) !== RUNTIME_USER_CLI_STATE_ROOT_MODE ||
		node.uid !== identity.uid ||
		node.gid !== identity.gid
	) {
		throw new Error(`hosted CLAWDI_HOME ownership or mode is invalid: ${path}`);
	}
}

function makeEgressIdentityPrivateDir(path: string): void {
	mkdirSync(path, { recursive: true });
	makeEgressIdentityOwned(path);
	try {
		chmodSync(path, 0o700);
	} catch {
		// Best effort for non-POSIX local development environments.
	}
}

function runtimeInstallerCommand(name: string, install: RuntimeInstall | undefined): string[] {
	if (!install) return [];
	if (name === "openclaw") {
		return ["bash", "<downloaded-official-openclaw-installer>", ...install.args];
	}
	if (name === "hermes") {
		return ["bash", "<downloaded-official-hermes-installer>", ...install.args];
	}
	return [];
}

function runtimeCommandPath(name: string, home: string): string | null {
	if (name === "openclaw") return join(home, ".local", "bin", "openclaw");
	if (name === "hermes") return join(home, ".local", "bin", "hermes");
	return null;
}

function runtimeAppRoot(name: string, home: string): string | null {
	if (name === "openclaw") return join(home, ".openclaw");
	if (name === "hermes") return join(home, ".hermes", "hermes-agent");
	return null;
}

const HERMES_DASHBOARD_CAPABILITY_PROBE =
	"import uvicorn; assert callable(getattr(uvicorn.Server, 'capture_signals', None))";
const DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

function runtimeInstallTimeoutMs(): number {
	const raw = process.env.CLAWDI_RUNTIME_INSTALL_TIMEOUT;
	if (raw === undefined) return DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS;
	const timeout = Number(raw);
	if (Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 0x7fffffff) return timeout;
	console.warn(
		`CLAWDI_RUNTIME_INSTALL_TIMEOUT must be a valid positive integer; using ${DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS}ms`,
	);
	return DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS;
}

function hermesDashboardCapabilityError(
	name: string,
	runtime: RuntimeManifest["runtimes"][string],
): string | null {
	if (name !== "hermes" || !runtime.enabled || !runtime.install || !runtime.services?.dashboard)
		return null;
	const python = join(runtime.install.home, ".hermes", "hermes-agent", "venv", "bin", "python");
	if (!executableExists(python)) {
		return `Hermes dashboard runtime is missing its managed Python interpreter: ${python}`;
	}
	let result: ReturnType<typeof spawnRuntimeUserCommand>;
	try {
		result = spawnRuntimeUserCommand(
			python,
			["-c", HERMES_DASHBOARD_CAPABILITY_PROBE],
			runtime.install.home,
			runtime.install.home,
			{ timeoutMs: 30_000 },
		);
	} catch (error) {
		return `Hermes dashboard runtime capability probe failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
	if (result.status === 0) return null;
	return `Hermes dashboard runtime is incompatible: ${
		tail(String(result.stderr ?? "")) ??
		(result.error instanceof Error
			? result.error.message
			: "uvicorn.Server.capture_signals is unavailable")
	}`;
}

const liveSyncEnvironmentIndexSchema = z
	.object({
		schemaVersion: z.literal("clawdi.liveSyncEnvironments.v1"),
		agentTypes: z.array(runtimeNameSchema).default([]),
	})
	.strict();

function runtimeInstallerExecution(
	runtime: string,
	install: RuntimeInstall,
	installerPath: string,
	extraArgs: string[] = [],
): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	executionUser: string | null;
} {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	const env = runtimeInstallerEnv(runtime, install);
	if (!runtimeUser || runtimeUser === "root") {
		return {
			command: "bash",
			args: [installerPath, ...install.args, ...extraArgs],
			env,
			executionUser: null,
		};
	}

	const child = buildRuntimeUserCommand(runtimeUser, install.home, "bash", [
		installerPath,
		...install.args,
		...extraArgs,
	]);
	return {
		command: child.command,
		args: child.args,
		env: { ...env, ...child.env },
		executionUser: runtimeUser,
	};
}

function runtimeInstallerEnv(runtime: string, install: RuntimeInstall): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: install.home,
		PATH: [join(install.home, ".local", "bin"), process.env.PATH].filter(Boolean).join(":"),
	};
	clearTenantToolLocationOverrides(env);
	if (runtime === "openclaw") {
		for (const key of [
			"OPENCLAW_HOME",
			"OPENCLAW_STATE_DIR",
			"OPENCLAW_CONFIG_PATH",
			"OPENCLAW_PREFIX",
			"OPENCLAW_VERSION",
			"OPENCLAW_INSTALL_METHOD",
			"OPENCLAW_GIT_DIR",
			"OPENCLAW_GIT_UPDATE",
		] as const) {
			delete env[key];
		}
	}
	env.SSL_CERT_FILE = SYSTEM_CA_BUNDLE;
	env.NODE_EXTRA_CA_CERTS = SYSTEM_CA_BUNDLE;
	env.REQUESTS_CA_BUNDLE = SYSTEM_CA_BUNDLE;
	env.CURL_CA_BUNDLE = SYSTEM_CA_BUNDLE;
	env.GIT_SSL_CAINFO = SYSTEM_CA_BUNDLE;
	env.NPM_CONFIG_CAFILE = SYSTEM_CA_BUNDLE;
	env.npm_config_cafile = SYSTEM_CA_BUNDLE;
	return env;
}

function tail(value: string | null | undefined): string | null {
	if (!value) return null;
	return value.slice(-4000);
}

function testInstallerEnvName(name: string): string | null {
	if (name === "openclaw") return "CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER";
	if (name === "hermes") return "CLAWDI_RUNTIME_TEST_HERMES_INSTALLER";
	return null;
}

function executionInstallerUrl(name: string, officialUrl: string): string {
	const envName = testInstallerEnvName(name);
	const override = envName ? process.env[envName]?.trim() : undefined;
	if (override) {
		if (process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1") {
			throw new Error(`${envName} requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1`);
		}
		return override;
	}
	return officialUrl;
}

function materializeInstaller(
	name: string,
	installerUrl: string,
): { path: string; cleanup?: string } {
	if (installerUrl.startsWith("file://")) {
		return { path: fileURLToPath(installerUrl) };
	}
	if (installerUrl.startsWith("/")) {
		return { path: installerUrl };
	}
	if (!installerUrl.startsWith("https://")) {
		throw new Error(`runtime ${name} installer must use https:// or a test file URL`);
	}
	const dir = mkdtempSync(join(tmpdir(), `clawdi-${name}-installer-`));
	chmodSync(dir, 0o755);
	const path = join(dir, "install.sh");
	const curl = spawnSync(
		"curl",
		["-fsSL", "--proto", "=https", "--tlsv1.2", "--retry", "3", "-o", path, installerUrl],
		{ encoding: "utf8" },
	);
	if (curl.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(
			`could not download ${name} official installer: ${tail(curl.stderr) ?? "curl failed"}`,
		);
	}
	chmodSync(path, 0o755);
	return { path, cleanup: dir };
}

function runOfficialInstaller(name: string, install: RuntimeInstall): RuntimeInstallObservation {
	const installStartedAt = new Date().toISOString();
	const installStartedMs = Date.now();
	const finish = (observation: RuntimeInstallObservation): RuntimeInstallObservation => ({
		...observation,
		installStartedAt,
		installFinishedAt: new Date().toISOString(),
		installDurationMs: Math.max(0, Date.now() - installStartedMs),
	});
	const commandPath = runtimeCommandPath(name, install.home);
	const appRoot = runtimeAppRoot(name, install.home);
	if (!commandPath || !appRoot) {
		return finish(
			runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: "install_failed",
				commandPath,
				appRoot,
				install,
				installerUrl: install.url,
				error: `unsupported runtime ${name}`,
			}),
		);
	}
	if (executableExists(commandPath)) {
		return finish(
			runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: "present",
				commandPath,
				appRoot,
				install,
				installerUrl: install.url,
			}),
		);
	}

	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(install.home));
	const url = executionInstallerUrl(name, install.url);
	const materialized = materializeInstaller(name, url);
	try {
		const execution = runtimeInstallerExecution(name, install, materialized.path);
		const result = spawnSync(execution.command, execution.args, {
			cwd: install.home,
			env: execution.env,
			encoding: "utf8",
			timeout: runtimeInstallTimeoutMs(),
		});
		const exitCode = result.status ?? 1;
		const installed = exitCode === 0 && executableExists(commandPath);
		return finish(
			runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: installed ? "installed" : "install_failed",
				executionUser: execution.executionUser,
				commandPath,
				appRoot,
				install,
				installerUrl: install.url,
				executedInstallerUrl: url === install.url ? install.url : url,
				exitCode,
				stdoutTail: tail(result.stdout),
				stderrTail: tail(result.stderr),
				error: installed
					? null
					: `runtime ${name} installer exited ${exitCode} or did not create ${commandPath}`,
			}),
		);
	} catch (error) {
		return finish(
			runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: "install_failed",
				commandPath,
				appRoot,
				install,
				installerUrl: install.url,
				executedInstallerUrl: url,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	} finally {
		if (materialized.cleanup) rmSync(materialized.cleanup, { recursive: true, force: true });
	}
}

function observeRuntimeInstall(
	name: string,
	runtime: RuntimeManifest["runtimes"][string],
	home: string,
) {
	if (!runtime.enabled) {
		return runtimeInstallObservation({
			runtime: name,
			enabled: false,
			status: "disabled",
			install: runtime.install ?? null,
			installerUrl: runtime.install?.url ?? null,
		});
	}
	if (!runtime.install) {
		if (runtime.run?.command?.trim() || isSupportedRuntimeName(name)) {
			const configuredCommand = runtime.run?.command?.trim() || null;
			const commandPath =
				isSupportedRuntimeName(name) && configuredCommand && commandResolvable(configuredCommand)
					? configuredCommand
					: null;
			return runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: "configured",
				commandPath,
				appRoot: commandPath ? runtimeAppRoot(name, home) : null,
			});
		}
		return runtimeInstallObservation({
			runtime: name,
			enabled: true,
			status: "install_failed",
			error: `runtime ${name} is enabled but missing install metadata`,
		});
	}
	const observation = runOfficialInstaller(name, runtime.install);
	if (observation.error) return observation;
	const capabilityError = hermesDashboardCapabilityError(name, runtime);
	return capabilityError
		? { ...observation, status: "install_failed" as const, error: capabilityError }
		: observation;
}

function planRuntimeInstallObservation(
	name: string,
	runtime: RuntimeManifest["runtimes"][string],
	home: string,
): RuntimeInstallObservation {
	if (!runtime.install) return observeRuntimeInstall(name, runtime, home);
	if (!runtime.enabled) return observeRuntimeInstall(name, runtime, home);
	const commandPath = runtimeCommandPath(name, runtime.install.home);
	const appRoot = runtimeAppRoot(name, runtime.install.home);
	return runtimeInstallObservation({
		runtime: name,
		enabled: true,
		status: commandPath && executableExists(commandPath) ? "present" : "configured",
		commandPath,
		appRoot,
		install: runtime.install,
		installerUrl: runtime.install.url,
		error: commandPath && appRoot ? null : `unsupported runtime ${name}`,
	});
}

function projectionPayload(name: string, manifest: RuntimeManifest): unknown {
	const projection =
		typeof manifest.projection === "object" && manifest.projection !== null
			? manifest.projection
			: undefined;
	return {
		schemaVersion: "clawdi.runtimeProjection.v1",
		runtime: name,
		generation: manifest.generation,
		instanceId: manifest.instanceId,
		locale: manifest.locale ?? null,
		managedBy: "clawdi runtime init",
		target:
			name === "openclaw"
				? "openclaw config patch --stdin"
				: name === "hermes"
					? "official Hermes user config"
					: "managed runtime integration config",
		projection: projection ?? null,
	};
}

const MANAGED_LOCALE_BLOCK_START = "<!-- >>> clawdi managed locale >>>";
const MANAGED_LOCALE_BLOCK_END = "<!-- <<< clawdi managed locale <<< -->";

function managedLocaleBlock(locale: NonNullable<RuntimeManifest["locale"]>): string {
	return [
		MANAGED_LOCALE_BLOCK_START,
		"## Clawdi managed locale",
		"",
		`Use \`${locale.language}\` as the default response language unless the user explicitly requests another language.`,
		`Interpret ambiguous dates and times in \`${locale.timezone}\` unless the user specifies another timezone.`,
		MANAGED_LOCALE_BLOCK_END,
	].join("\n");
}

function nextManagedLocaleFileContent(
	path: string,
	block: string,
): {
	existing: string;
	next: string;
} {
	const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
	const start = existing.indexOf(MANAGED_LOCALE_BLOCK_START);
	const end = existing.indexOf(MANAGED_LOCALE_BLOCK_END);
	const hasStart = start !== -1;
	const hasEnd = end !== -1;
	if (hasStart !== hasEnd || (hasStart && end < start)) {
		throw new Error(`managed locale block markers are malformed in ${path}`);
	}
	if (
		hasStart &&
		(existing.indexOf(MANAGED_LOCALE_BLOCK_START, start + MANAGED_LOCALE_BLOCK_START.length) !==
			-1 ||
			existing.indexOf(MANAGED_LOCALE_BLOCK_END, end + MANAGED_LOCALE_BLOCK_END.length) !== -1)
	) {
		throw new Error(`managed locale block markers are duplicated in ${path}`);
	}

	let next: string;
	if (hasStart && hasEnd) {
		const suffixStart = end + MANAGED_LOCALE_BLOCK_END.length;
		next = `${existing.slice(0, start)}${block}${existing.slice(suffixStart)}`;
	} else {
		const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		next = `${existing}${separator}${block}\n`;
	}

	return { existing, next };
}

function updateManagedLocaleFile(path: string, block: string): string {
	return withRuntimeUserFileAccess(() => {
		const { existing, next } = nextManagedLocaleFileContent(path, block);
		if (next === existing) return path;
		writePrivateFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 });
		makeRuntimeUserOwned(path);
		return path;
	});
}

function hermesConfigContext(
	observation: RuntimeInstallObservation,
	home: string,
	cwd: string,
): HermesConfigCommandContext {
	if (!observation.commandPath || !executableExists(observation.commandPath)) {
		throw new Error("Hermes config command is unavailable");
	}
	return { command: observation.commandPath, home, cwd };
}

function applyHermesDashboardConfig(
	context: HermesConfigCommandContext,
	auth: NonNullable<RuntimeManifest["hermesDashboardAuth"]>,
): void {
	reconcileHermesConfigValue(context, "dashboard.basic_auth", {
		username: auth.username,
		session_ttl_seconds: auth.sessionTtlSeconds,
	});
	reconcileHermesConfigValue(context, "dashboard.public_url", auth.publicUrl);
	const currentDisabled = getHermesRawConfigValue(context, "plugins.disabled");
	if (
		currentDisabled.exists &&
		(!Array.isArray(currentDisabled.value) ||
			currentDisabled.value.some((value) => typeof value !== "string"))
	) {
		throw new Error("Hermes config field plugins.disabled must be a string array");
	}
	const disabled = new Set(
		(currentDisabled.exists ? (currentDisabled.value as string[]) : []).filter(
			(value) => value !== "dashboard_auth/basic",
		),
	);
	disabled.add("dashboard_auth/nous");
	disabled.add("dashboard_auth/self_hosted");
	reconcileHermesConfigValue(context, "plugins.disabled", [...disabled].sort());
}

function applyHostedRuntimeConfigProjection(
	runtime: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	openClawWorkspaceRoot: string | null,
	workspaceRoot: string,
): string | null {
	if (manifest.runtimes[runtime]?.enabled !== true) return null;
	const locale = manifest.locale;
	if (runtime === "openclaw") {
		if (!openClawWorkspaceRoot) throw new Error("OpenClaw official agent workspace is unavailable");
		return locale
			? updateManagedLocaleFile(join(openClawWorkspaceRoot, "SOUL.md"), managedLocaleBlock(locale))
			: null;
	}
	if (runtime === "hermes") {
		const auth = manifest.hermesDashboardAuth;
		const managesWorkspace =
			manifest.projection?.sourceBundleVersion === HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION;
		if (!auth && !locale && !managesWorkspace) return null;
		const context = hermesConfigContext(observation, home, workspaceRoot);
		const hermesHome = join(home, ".hermes");
		if (managesWorkspace) reconcileHermesConfigValue(context, "terminal.cwd", workspaceRoot);
		if (auth) applyHermesDashboardConfig(context, auth);
		if (locale) reconcileHermesConfigValue(context, "timezone", locale.timezone);
		return locale
			? updateManagedLocaleFile(join(hermesHome, "SOUL.md"), managedLocaleBlock(locale))
			: null;
	}
	return null;
}

function resolvedRuntimeServiceSettings(
	manifest: RuntimeManifest,
	runtime: RuntimeName,
	service: RuntimeServiceName,
	settings: RuntimeRunSettings,
	providerEnv: Record<string, string>,
): RuntimeRunSettings {
	const merged = mergeRuntimeServiceEnvWithProviderPlaceholders(
		runtime,
		service,
		settings,
		providerEnv,
	);
	return runtime === "hermes" && service === "dashboard"
		? (withHermesDashboardAuthEnvironment(manifest, merged) ?? merged)
		: merged;
}

function resolvedRuntimeSettings(
	runtime: string,
	settings: RuntimeRunSettings | undefined,
	providerEnv: Record<string, string>,
): RuntimeRunSettings | undefined {
	return mergeRuntimeEnvWithProviderPlaceholders(runtime, settings, providerEnv);
}

function mergeRuntimeSecretEnv(
	runtimeName: string,
	settings: RuntimeRunSettings | undefined,
	providerSecretEnv: Record<string, string>,
	serviceName?: string,
): Record<string, string> {
	const scope = `runtime ${runtimeName}${serviceName ? ` service ${serviceName}` : ""}`;
	const merged = { ...providerSecretEnv };
	const runtimeSecretEnv = settings?.secretEnv ?? {};
	for (const [envName, ref] of Object.entries(runtimeSecretEnv)) {
		const existing = merged[envName];
		if (existing !== undefined && existing !== ref) {
			throw new Error(
				`${scope} secretEnv.${envName} conflicts with provider secret ref ${existing}`,
			);
		}
		merged[envName] = ref;
	}
	for (const envName of Object.keys(settings?.env ?? {})) {
		if (merged[envName] !== undefined) {
			throw new Error(`${scope} defines ${envName} in both env and secretEnv`);
		}
	}
	return merged;
}

function egressSecretFilePath(paths: RuntimePaths): string {
	return join(paths.managedSecretRoot, "egress-secrets.json");
}

interface RuntimeEgressSecretMaterial {
	content: string | null;
	revision: string;
}

function egressSecretMaterialRevision(secretValues: Record<string, string>): string {
	return runtimeContentSha256({
		schemaVersion: "clawdi.runtimeEgressSidecarSecrets.v1",
		secretValues,
	});
}

function egressSecretMaterial(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
): RuntimeEgressSecretMaterial {
	const scoped = scopedSecretValues(secretValues, egressSecretRefs(manifest));
	return {
		content: Object.keys(scoped).length > 0 ? `${JSON.stringify(scoped, null, 2)}\n` : null,
		revision: egressSecretMaterialRevision(scoped),
	};
}

function egressSecretRevisionFromContent(content: string | null): string | null {
	if (content === null) return egressSecretMaterialRevision({});
	try {
		const parsed = JSON.parse(content) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const secretValues: Record<string, string> = {};
		for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value !== "string") return null;
			secretValues[ref] = value;
		}
		return egressSecretMaterialRevision(secretValues);
	} catch {
		return null;
	}
}

function writeEgressSecretMaterial(
	material: RuntimeEgressSecretMaterial,
	paths: RuntimePaths,
): string | null {
	const path = egressSecretFilePath(paths);
	if (material.content === null) {
		rmSync(path, { force: true });
		return null;
	}
	writeRuntimePrivateFileAtomic(paths, path, material.content, {
		mode: 0o600,
		dirMode: 0o700,
	});
	makeEgressIdentityOwned(path);
	makeManagedSecretRoot(paths.managedSecretRoot);
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort for non-POSIX local development environments.
	}
	return path;
}

function writeEgressSecretFile(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	paths: RuntimePaths,
): {
	path: string | null;
	changed: boolean;
	material: RuntimeEgressSecretMaterial;
	previousRevision: string | null;
} {
	const secretFilePath = egressSecretFilePath(paths);
	const previousContent = existsSync(secretFilePath) ? readFileSync(secretFilePath, "utf-8") : null;
	const material = egressSecretMaterial(manifest, secretValues);
	const path = writeEgressSecretMaterial(material, paths);
	return {
		path,
		changed: previousContent !== material.content,
		material,
		previousRevision: egressSecretRevisionFromContent(previousContent),
	};
}

function verifiedCommittedEgressSecretMaterial(
	paths: RuntimePaths,
	applyContext: RuntimeApplyContext,
): RuntimeEgressSecretMaterial | null {
	try {
		const committed = loadCommittedRuntimeManifest(paths, applyContext);
		if ("errors" in committed) return null;
		return egressSecretMaterial(committed.manifest, committed.secretValues);
	} catch {
		return null;
	}
}

function egressSecretRefs(manifest: RuntimeManifest): string[] {
	return egressProfileSecretRefs(manifest.egressProfiles);
}

function egressSidecarOnlySecretRefs(manifest: RuntimeManifest): string[] {
	const refs = new Set<string>();
	const profiles = Array.isArray(manifest.egressProfiles?.profiles)
		? manifest.egressProfiles.profiles
		: [];
	for (const profile of profiles) {
		const profileRecord = recordValue(profile);
		if (profileRecord?.owner === "provider-projection") {
			collectSecretRefs(profile, refs);
		}
		if (profileRecord?.owner === "mcp-projection") {
			collectSecretRefs(profile, refs);
		}
		if (profileRecord?.owner === "clawdi-native-channels") {
			collectChannelRewriteSecretRefs(profileRecord, refs);
		}
	}
	return [...refs].sort();
}

function collectChannelRewriteSecretRefs(
	profile: Record<string, unknown>,
	refs: Set<string>,
): void {
	const rewrite = recordValue(profile.rewrite);
	if (!rewrite) return;
	const pathReplace = recordValue(rewrite.pathReplace);
	const replacementSecretRef = stringValue(pathReplace?.replacementSecretRef);
	if (replacementSecretRef) refs.add(replacementSecretRef);
	const setHeaders = recordValue(rewrite.setHeaders);
	if (!setHeaders) return;
	for (const setter of Object.values(setHeaders)) {
		const setterRecord = recordValue(setter);
		if (setterRecord?.type !== "secretRef") continue;
		const secretRef = stringValue(setterRecord.secretRef);
		if (secretRef) refs.add(secretRef);
	}
}

function collectSecretRefs(value: unknown, refs: Set<string>): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectSecretRefs(item, refs);
		return;
	}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string" && (key === "secretRef" || key.endsWith("SecretRef"))) {
			refs.add(entry);
		}
		collectSecretRefs(entry, refs);
	}
}

interface HostedAiProviderProjectionResult {
	path: string | null;
	revision: string | null;
	providerIds: string[];
}

const CODEX_MANAGED_PROVIDER_ID = "clawdi";
const CODEX_MANAGED_PROVIDER_CONFIG_FILE = "config.toml";
const CODEX_BOOTSTRAP_PACKAGE_VERSION = "0.146.0";
const CODEX_BOOTSTRAP_PACKAGE_SPEC = `@openai/codex@${CODEX_BOOTSTRAP_PACKAGE_VERSION}`;

interface HostedCodexManagedProvider {
	baseUrl: string;
}

function runtimeOAuthLedgerPath(
	paths: RuntimePaths,
	runtime: "hermes" | "openclaw",
	providerId: string,
): string {
	return oauthCredentialLedgerPath(paths.oauthCredentialRoot, runtime, providerId);
}

function writeRuntimeOAuthLedger(
	path: string,
	runtime: "hermes" | "openclaw",
	providerId: string,
	snapshot: OAuthCredentialLedgerSnapshot,
): void {
	writeOAuthCredentialLedger(path, { runtime, providerId }, snapshot);
}

function readRuntimeOAuthLedger(path: string): OAuthCredentialLedger | null {
	return readOAuthCredentialLedger(path, { migrateLegacy: true });
}

function decodeJwtExpiryMs(token: string): number | null {
	const encoded = token.split(".")[1];
	if (!encoded) return null;
	try {
		const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
		const exp = recordValue(payload)?.exp;
		return typeof exp === "number" && Number.isFinite(exp) ? Math.trunc(exp * 1000) : null;
	} catch {
		return null;
	}
}

function parseHostedRuntimeOAuthMaterial(payload: string): RuntimeOAuthMaterial {
	const envelope = recordValue(JSON.parse(payload) as unknown);
	if (envelope?.kind !== "local_agent_profile" || !Array.isArray(envelope.files)) {
		throw new Error("hosted OAuth secret is not a local Agent credential profile");
	}
	const authFile = envelope.files
		.map(recordValue)
		.find((file) => file?.logicalName === "auth.json");
	if (!authFile || typeof authFile.content !== "string") {
		throw new Error("hosted OAuth credential profile is missing auth.json");
	}
	const auth = recordValue(JSON.parse(authFile.content) as unknown);
	const tokens = recordValue(auth?.tokens);
	const accessToken = stringValue(tokens?.access_token);
	const refreshToken = stringValue(tokens?.refresh_token);
	if (!accessToken || !refreshToken) {
		throw new Error("hosted OAuth credential profile is missing access or refresh token");
	}
	return {
		accessToken,
		refreshToken,
		...(stringValue(tokens?.id_token)
			? { idToken: stringValue(tokens?.id_token) ?? undefined }
			: {}),
		...(stringValue(tokens?.account_id)
			? { accountId: stringValue(tokens?.account_id) ?? undefined }
			: {}),
		lastRefresh: stringValue(auth?.last_refresh) ?? new Date().toISOString(),
		expires: decodeJwtExpiryMs(accessToken) ?? Date.now() + 60 * 60 * 1000,
	};
}

function hostedRuntimeOAuthCredentials(
	manifest: RuntimeManifest,
	runtime: "hermes" | "openclaw",
	secretValues: Record<string, string> | undefined,
): HostedRuntimeOAuthCredential[] {
	if (manifest.runtimes[runtime]?.enabled !== true) return [];
	const providers = recordValue(manifest.projection?.providers);
	if (!providers) return [];
	return (manifest.runtimes[runtime]?.provider_ids ?? []).flatMap((providerId) => {
		const raw = providers[providerId];
		const provider = recordValue(raw);
		const auth = recordValue(provider?.auth);
		if (
			auth?.type !== "agent_profile" ||
			auth.tool !== "codex" ||
			typeof auth.profile !== "string" ||
			typeof auth.credentialSecretRef !== "string" ||
			typeof auth.credentialRevision !== "string"
		) {
			return [];
		}
		const payload = runtimeSecretValue(secretValues ?? {}, auth.credentialSecretRef);
		if (!payload) throw new Error(`hosted OAuth secret is unavailable for ${providerId}`);
		return [
			{
				providerId,
				profile: auth.profile,
				credentialRevision: auth.credentialRevision,
				material: parseHostedRuntimeOAuthMaterial(payload),
			},
		];
	});
}

function hermesAuthPath(home: string): string {
	return join(home, ".hermes", "auth.json");
}

function runHermesCodexAuthCommand(
	home: string,
	workspaceRoot: string,
	input: RuntimeOAuthCredentialCommand,
): Record<string, unknown> {
	const authPath = hermesAuthPath(home);
	enforceRuntimeUserOwnership(
		runtimeUserDirectoryOwnership(dirname(authPath), { mode: 0o700, ancestorsUnder: home }),
	);
	const result = spawnRuntimeUserCommand(
		"flock",
		[
			"--timeout",
			"10",
			join(dirname(authPath), "auth.lock"),
			"node",
			"--input-type=module",
			"--eval",
			HERMES_CODEX_AUTH_HELPER,
			authPath,
			input.action,
			input.nativeProfileId,
			input.ownership?.nativeProfileId ?? "",
			input.credentialRevision,
			input.expectedFingerprint ?? "",
		],
		home,
		workspaceRoot,
		{ input: input.material ? JSON.stringify(input.material) : "null" },
	);
	if (result.status !== 0) {
		throw new Error(
			`Hermes Codex auth ${input.action} failed: ${tail(String(result.stderr ?? "")) ?? "unknown"}`,
		);
	}
	const output = recordValue(JSON.parse(String(result.stdout || "{}")) as unknown);
	return output ?? {};
}

const OPENCLAW_OWNER_BROWSER_BOOTSTRAP_CAPABILITY_PROBE = `
import { pathToFileURL } from "node:url";
const sdk = await import(pathToFileURL(process.argv[1]).href);
const normalized = typeof sdk.normalizeDeviceBootstrapProfile === "function"
  ? sdk.normalizeDeviceBootstrapProfile({ purpose: "control-ui-owner" })
  : null;
process.stdout.write(normalized?.purpose === "control-ui-owner" ? "supported" : "unsupported");
`;

function openClawSupportsOwnerBrowserBootstrap(context: OpenClawHostedContext): boolean {
	const sdkPath = context.sdk.deviceBootstrap;
	if (!sdkPath) return false;
	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(context.home));
	const result = spawnRuntimeUserCommand(
		"node",
		["--input-type=module", "--eval", OPENCLAW_OWNER_BROWSER_BOOTSTRAP_CAPABILITY_PROBE, sdkPath],
		context.home,
		context.home,
	);
	if (result.status !== 0) {
		throw new Error(
			`installed OpenClaw device-bootstrap capability probe failed: ${
				tail(String(result.stderr ?? "")) ?? "unknown"
			}`,
		);
	}
	const outcome = String(result.stdout ?? "").trim();
	if (outcome === "supported") return true;
	if (outcome === "unsupported") return false;
	throw new Error("installed OpenClaw device-bootstrap capability probe returned invalid output");
}

const OPENCLAW_PROVIDER_AUTH_CAPABILITY_PROBE = `
import { pathToFileURL } from "node:url";
const sdk = await import(pathToFileURL(process.argv[1]).href);
if (${openClawSdkFunctionGuard("sdk", OPENCLAW_PROVIDER_AUTH_MUTATION_EXPORTS)}) {
  throw new Error("required public provider-auth exports are missing");
}
`;

const OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_CAPABILITY_PROBE = `
import { pathToFileURL } from "node:url";
const providerAuth = await import(pathToFileURL(process.argv[1]).href);
const configMutation = await import(pathToFileURL(process.argv[2]).href);
const providerEnvVars = await import(pathToFileURL(process.argv[3]).href);
if (
  ${openClawSdkFunctionGuard("providerAuth", OPENCLAW_PROVIDER_AUTH_CLEANUP_EXPORTS)} ||
  ${openClawSdkFunctionGuard("configMutation", OPENCLAW_CONFIG_MUTATION_EXPORTS)} ||
  ${openClawSdkFunctionGuard("providerEnvVars", OPENCLAW_PROVIDER_ENV_VARS_EXPORTS)}
) {
  throw new Error("required public OpenClaw auth cleanup exports are missing");
}
`;

function requireOpenClawProviderAuthCapability(context: OpenClawHostedContext): void {
	const sdkPath = context.requireSdkExport("providerAuth");
	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(context.home));
	const result = spawnRuntimeUserCommand(
		"node",
		["--input-type=module", "--eval", OPENCLAW_PROVIDER_AUTH_CAPABILITY_PROBE, sdkPath],
		context.home,
		context.home,
	);
	if (result.status !== 0) {
		throw new Error(
			`installed OpenClaw public provider-auth SDK is incompatible: ${
				tail(String(result.stderr ?? "")) ?? "capability probe failed"
			}`,
		);
	}
}

function requireOpenClawManagedProviderAuthCleanupCapability(context: OpenClawHostedContext): void {
	const providerAuthSdkPath = context.requireSdkExport("providerAuth");
	const configMutationSdkPath = context.sdk.configMutation;
	if (!configMutationSdkPath) {
		throw new Error("installed OpenClaw public config-mutation SDK export is unavailable");
	}
	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(context.home));
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_CAPABILITY_PROBE,
			providerAuthSdkPath,
			configMutationSdkPath,
			context.requireSdkExport("providerEnvVars"),
		],
		context.home,
		context.home,
	);
	if (result.status !== 0) {
		throw new Error(
			`installed OpenClaw public managed-provider auth cleanup SDK is incompatible: ${
				tail(String(result.stderr ?? "")) ?? "capability probe failed"
			}`,
		);
	}
}

function ensureHostedOpenClawProviderAuthCapability(input: {
	manifest: RuntimeManifest;
	secretValues: Record<string, string> | undefined;
	context: OpenClawHostedContext;
}): void {
	const desired = hostedRuntimeOAuthCredentials(input.manifest, "openclaw", input.secretValues);
	const cleanupManagedProvider = input.context.managedApiKeyProjection;
	if (desired.length === 0 && !cleanupManagedProvider) return;
	const requirement =
		desired.length > 0 && cleanupManagedProvider
			? "OpenClaw credential convergence"
			: cleanupManagedProvider
				? "OpenClaw managed API-key cleanup"
				: "OpenClaw OAuth";
	try {
		if (desired.length > 0) requireOpenClawProviderAuthCapability(input.context);
		if (cleanupManagedProvider) {
			requireOpenClawManagedProviderAuthCleanupCapability(input.context);
		}
	} catch (initialError) {
		const detail = initialError instanceof Error ? initialError.message : String(initialError);
		throw new Error(
			`${requirement} requires the public OpenClaw SDK; automatic runtime reinstall is disabled: ${
				tail(detail) ?? "capability probe failed"
			}`,
		);
	}
}

function runOpenClawProviderAuthCommand(
	context: OpenClawHostedContext,
	workspaceRoot: string,
	input: RuntimeOAuthCredentialCommand,
): Record<string, unknown> {
	const credential = input.material
		? JSON.stringify({
				type: "oauth",
				provider: OPENCLAW_CODEX_PROVIDER_ID,
				access: input.material.accessToken,
				refresh: input.material.refreshToken,
				expires: input.material.expires,
				...(input.material.idToken ? { idToken: input.material.idToken } : {}),
				...(input.material.accountId ? { accountId: input.material.accountId } : {}),
				copyToAgents: false,
			})
		: "";
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_PROVIDER_AUTH_HELPER,
			context.requireSdkExport("providerAuth"),
			context.agentDirs.main,
			input.action,
			input.nativeProfileId,
			input.ownership?.nativeProfileId ?? "",
			input.credentialRevision,
			input.expectedFingerprint ?? "",
		],
		context.home,
		workspaceRoot,
		{ input: credential || "null" },
	);
	if (result.status !== 0) {
		throw new Error(
			`OpenClaw provider-auth ${input.action} failed: ${tail(String(result.stderr ?? "")) ?? "unknown"}`,
		);
	}
	const output = recordValue(JSON.parse(String(result.stdout || "{}")) as unknown);
	return output ?? {};
}
function removeOpenClawManagedProviderAuthProfiles(
	context: OpenClawHostedContext,
	workspaceRoot: string,
): void {
	const configMutationSdkPath = context.sdk.configMutation;
	if (!configMutationSdkPath) {
		throw new Error("installed OpenClaw public config-mutation SDK export is unavailable");
	}
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_HELPER,
			context.requireSdkExport("providerAuth"),
			configMutationSdkPath,
			context.home,
			"cleanup",
			JSON.stringify(context.agentDirs.managed),
		],
		context.home,
		workspaceRoot,
	);
	if (result.status !== 0) {
		throw new Error(
			`OpenClaw managed provider-auth cleanup failed: ${
				tail(String(result.stderr || result.stdout || "")) ?? "unknown"
			}`,
		);
	}
}

function discoverOpenClawManagedProviderAuthAgentDirs(context: OpenClawHostedContext): string[] {
	const configMutationSdkPath = context.sdk.configMutation;
	if (!configMutationSdkPath) {
		throw new Error("installed OpenClaw public config-mutation SDK export is unavailable");
	}
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_MANAGED_PROVIDER_AUTH_CLEANUP_HELPER,
			context.requireSdkExport("providerAuth"),
			configMutationSdkPath,
			context.home,
			"discover",
		],
		context.home,
		context.home,
	);
	if (result.status !== 0) {
		throw new Error(
			`OpenClaw managed provider-auth store discovery failed: ${
				tail(String(result.stderr || result.stdout || "")) ?? "unknown"
			}`,
		);
	}
	const output = recordValue(JSON.parse(String(result.stdout || "{}")) as unknown);
	if (!output || !Array.isArray(output.agentDirs)) {
		throw new Error("OpenClaw managed provider-auth store discovery returned invalid output");
	}
	const agentDirs = output.agentDirs.filter((path): path is string => typeof path === "string");
	if (agentDirs.length !== output.agentDirs.length || agentDirs.length === 0) {
		throw new Error("OpenClaw managed provider-auth store discovery returned invalid targets");
	}
	return agentDirs;
}

function runtimeOAuthLedgerOwnership(
	ledger: OAuthCredentialLedger | null,
): OAuthCredentialOwnership | undefined {
	if (!ledger) return undefined;
	const credentialFingerprint =
		ledger.state === "seeded"
			? ledger.credentialFingerprint
			: ledger.state === "intent" && ledger.operation === "remove"
				? ledger.beforeCredentialFingerprint
				: undefined;
	if (ledger.state !== "seeded" && !(ledger.state === "intent" && ledger.operation === "remove")) {
		return undefined;
	}
	return {
		nativeProfileId: ledger.nativeProfileId,
		...(credentialFingerprint
			? {
					credentialRevision: ledger.credentialRevision,
					credentialFingerprint,
				}
			: {}),
	};
}

function runtimeOAuthCredentialDriver(
	run: (input: RuntimeOAuthCredentialCommand) => Record<string, unknown>,
): RuntimeOAuthCredentialDriver {
	return {
		observe: (input) => nativeOAuthObservation(run({ ...input, action: "inspect" })),
		mutate: (input) => nativeOAuthMutationResult(run(input)),
	};
}

function hostedRuntimeOAuthCredentialDriver(input: {
	runtime: "hermes" | "openclaw";
	home: string;
	openClawContext: OpenClawHostedContext;
	workspaceRoot: string;
}): RuntimeOAuthCredentialDriver {
	if (input.runtime === "hermes") {
		return runtimeOAuthCredentialDriver((command) =>
			runHermesCodexAuthCommand(input.home, input.workspaceRoot, command),
		);
	}
	return runtimeOAuthCredentialDriver((command) =>
		runOpenClawProviderAuthCommand(input.openClawContext, input.workspaceRoot, command),
	);
}

function executeHostedRuntimeOAuthAction(input: {
	decision: ReturnType<typeof decideChatGptOAuthCredentialReconciliation>;
	driver: RuntimeOAuthCredentialDriver;
	runtime: "hermes" | "openclaw";
	nativeProfileId: string;
	credentialRevision: string;
	material: RuntimeOAuthMaterial;
}): void {
	const action = input.decision.nativeAction;
	if (action === "preserve") return;
	if (action === "remove") {
		throw new Error("Desired hosted OAuth reconciliation cannot remove a credential");
	}
	const adapterAction = action === "seed" ? "seed-if-missing" : "upsert";
	const expectedFingerprint =
		action === "seed"
			? "missing"
			: requireRuntimeDecisionFingerprint(input.decision.expectedCredentialFingerprint, "before");
	const targetFingerprint = requireRuntimeDecisionFingerprint(
		input.decision.targetCredentialFingerprint,
		"target",
	);
	const result = input.driver.mutate({
		action: adapterAction,
		nativeProfileId: input.nativeProfileId,
		credentialRevision: input.credentialRevision,
		material: input.material,
		expectedFingerprint,
	});
	assertRuntimeNativeMutationCompleted(
		result,
		expectedFingerprint,
		targetFingerprint,
		`${input.runtime} OAuth credential`,
	);
}

function removeHostedRuntimeOAuthCredential(input: {
	driver: RuntimeOAuthCredentialDriver;
	runtime: "hermes" | "openclaw";
	nativeProfileId: string;
	credentialRevision: string;
	ownership: OAuthCredentialOwnership;
	expectedFingerprint: string;
}): void {
	const result = input.driver.mutate({
		action: "remove",
		nativeProfileId: input.nativeProfileId,
		credentialRevision: input.credentialRevision,
		ownership: input.ownership,
		expectedFingerprint: input.expectedFingerprint,
	});
	assertRuntimeNativeRemovalCompleted(
		result,
		input.expectedFingerprint,
		`${input.runtime} OAuth credential`,
	);
}

function requireRuntimeDecisionFingerprint(value: string | undefined, label: string): string {
	if (!value) throw new Error(`OAuth credential decision is missing ${label} fingerprint evidence`);
	return value;
}

function assertRuntimeNativeMutationCompleted(
	result: NativeOAuthCredentialMutationResult,
	expectedFingerprint: string,
	targetFingerprint: string,
	label: string,
): void {
	if (!result.casMatched) throw new Error(`${label} changed before the mutation could be applied`);
	assertRuntimeNativeMutationBeforeEvidence(result, expectedFingerprint, label);
	if (!result.updated || result.afterCredentialFingerprint !== targetFingerprint) {
		throw new Error(`${label} mutation did not produce the intended fingerprint`);
	}
}

function assertRuntimeNativeRemovalCompleted(
	result: NativeOAuthCredentialMutationResult,
	expectedFingerprint: string,
	label: string,
): void {
	if (!result.casMatched) throw new Error(`${label} changed before removal could be applied`);
	assertRuntimeNativeMutationBeforeEvidence(result, expectedFingerprint, label);
	if (!result.updated || result.afterCredentialFingerprint) {
		throw new Error(`${label} removal could not verify absence`);
	}
}

function assertRuntimeNativeMutationBeforeEvidence(
	result: NativeOAuthCredentialMutationResult,
	expectedFingerprint: string,
	label: string,
): void {
	const matches =
		expectedFingerprint === "missing"
			? result.beforeCredentialFingerprint === undefined
			: result.beforeCredentialFingerprint === expectedFingerprint;
	if (!matches) throw new Error(`${label} mutation returned inconsistent before evidence`);
}

function reconcileHostedRuntimeOAuthCredentials(input: {
	runtime: "hermes" | "openclaw";
	manifest: RuntimeManifest;
	secretValues: Record<string, string> | undefined;
	paths: RuntimePaths;
	home: string;
	openClawContext: OpenClawHostedContext;
	workspaceRoot: string;
}): void {
	const desired = hostedRuntimeOAuthCredentials(input.manifest, input.runtime, input.secretValues);
	const driver = hostedRuntimeOAuthCredentialDriver(input);
	const desiredProviderIds = new Set(desired.map((credential) => credential.providerId));
	const ledgerDir = join(input.paths.oauthCredentialRoot, input.runtime);
	if (existsSync(ledgerDir)) {
		for (const filename of readdirSync(ledgerDir).filter((name) => name.endsWith(".json"))) {
			const path = join(ledgerDir, filename);
			const ledger = readRuntimeOAuthLedger(path);
			if (!ledger || desiredProviderIds.has(ledger.providerId) || ledger.state === "retired") {
				continue;
			}
			const snapshot = oauthCredentialLedgerSnapshot(ledger);
			const ownership = runtimeOAuthLedgerOwnership(ledger);
			const native = driver.observe({
				nativeProfileId: ledger.nativeProfileId,
				credentialRevision: ledger.credentialRevision,
				ownership,
			});
			const decision = decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: null,
				desiredNativeProfileId: null,
				desiredCredentialFingerprint: null,
				ledger: snapshot,
				native,
			});
			if (decision.requiresWriteAheadIntent) {
				writeRuntimeOAuthLedger(
					path,
					input.runtime,
					ledger.providerId,
					intentLedgerForDecision(decision),
				);
			}
			if (decision.nativeAction === "remove") {
				const expectedFingerprint = requireRuntimeDecisionFingerprint(
					decision.expectedCredentialFingerprint,
					"before",
				);
				const removalOwnership = ownership ?? {
					nativeProfileId: ledger.nativeProfileId,
					credentialRevision: ledger.credentialRevision,
					credentialFingerprint: expectedFingerprint,
				};
				removeHostedRuntimeOAuthCredential({
					driver,
					runtime: input.runtime,
					nativeProfileId: ledger.nativeProfileId,
					credentialRevision: ledger.credentialRevision,
					ownership: removalOwnership,
					expectedFingerprint,
				});
			}
			writeRuntimeOAuthLedger(path, input.runtime, ledger.providerId, decision.nextLedger);
		}
	}
	for (const credential of desired) {
		const ledgerPath = runtimeOAuthLedgerPath(input.paths, input.runtime, credential.providerId);
		const ledger = readRuntimeOAuthLedger(ledgerPath);
		const snapshot = oauthCredentialLedgerSnapshot(ledger);
		const nativeProfileId = nativeOAuthProfileId(input.runtime, credential.providerId);
		const desiredFingerprint = oauthCredentialFingerprint(
			credential.credentialRevision,
			credential.material.accessToken,
			credential.material.refreshToken,
		);
		const native = driver.observe({
			nativeProfileId,
			credentialRevision: credential.credentialRevision,
			ownership: runtimeOAuthLedgerOwnership(ledger),
		});
		const decision = decideChatGptOAuthCredentialReconciliation({
			desiredCredentialRevision: credential.credentialRevision,
			desiredNativeProfileId: nativeProfileId,
			desiredCredentialFingerprint: desiredFingerprint,
			ledger: snapshot,
			native,
		});
		if (decision.requiresWriteAheadIntent) {
			writeRuntimeOAuthLedger(
				ledgerPath,
				input.runtime,
				credential.providerId,
				intentLedgerForDecision(decision),
			);
		}
		executeHostedRuntimeOAuthAction({
			decision,
			driver,
			runtime: input.runtime,
			nativeProfileId,
			credentialRevision: credential.credentialRevision,
			material: credential.material,
		});
		writeRuntimeOAuthLedger(ledgerPath, input.runtime, credential.providerId, decision.nextLedger);
	}
}

function applyHostedAiProviderProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	home: string,
	openClawContext: OpenClawHostedContext,
	workspaceRoot: string,
	previousProviderIds: readonly string[],
	openClawOwnerBrowserBootstrapSupported: boolean,
): HostedAiProviderProjectionResult {
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return { path: null, revision: null, providerIds: [] };
	}
	const projectionInput = agentTargetProjectionInput(hostedAiProviderCatalog(manifest, name));
	assertHostedProviderProjectionMode(name, manifest, projectionInput);
	if (manifest.runtimes[name]?.providerMode === "configured" && !projectionInput) {
		if (name === "openclaw") {
			applyOpenClawGatewayHostedProjection(
				observation.commandPath,
				manifest,
				secretValues,
				openClawContext,
				workspaceRoot,
				openClawOwnerBrowserBootstrapSupported,
			);
		}
		return { path: null, revision: null, providerIds: [...previousProviderIds] };
	}
	if (name === "hermes") {
		return applyHostedHermesAiProviderProjection(
			observation,
			projectionInput,
			previousProviderIds,
			home,
			workspaceRoot,
		);
	}
	if (name === "openclaw") {
		applyOpenClawGatewayHostedProjection(
			observation.commandPath,
			manifest,
			secretValues,
			openClawContext,
			workspaceRoot,
			openClawOwnerBrowserBootstrapSupported,
		);
		const providerPatch = buildOpenClawHostedProviderPatch(projectionInput, previousProviderIds);
		if (providerPatch.apply) {
			applyOpenClawHostedProviderPatch(observation, providerPatch, openClawContext, workspaceRoot);
		}
		if (openClawContext.managedApiKeyProjection) {
			if (openClawContext.agentDirs.managed.length === 0) {
				throw new Error(
					"OpenClaw managed provider-auth stores were not transactionally discovered",
				);
			}
			removeOpenClawManagedProviderAuthProfiles(openClawContext, workspaceRoot);
		}
		return {
			path: observation.commandPath,
			revision: null,
			providerIds: providerPatch.providerIds,
		};
	}
	return { path: null, revision: null, providerIds: [] };
}

function previewHostedAiProviderProjectionRevision(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	previousProviderIds: readonly string[],
): string | null {
	if (
		(name !== "openclaw" && name !== "hermes") ||
		!observation.enabled ||
		observation.status === "install_failed" ||
		!observation.commandPath
	) {
		return null;
	}
	const projectionInput = agentTargetProjectionInput(hostedAiProviderCatalog(manifest, name));
	assertHostedProviderProjectionMode(name, manifest, projectionInput);
	if (manifest.runtimes[name]?.providerMode === "configured" && !projectionInput) {
		return null;
	}
	if (name === "openclaw") {
		const providerPatch = buildOpenClawHostedProviderPatch(projectionInput, previousProviderIds);
		if (!projectionInput) {
			return runtimeImpactRevision({
				openClawProviderProjection: "delete",
				patch: JSON.parse(providerPatch.content) as unknown,
			});
		}
		return runtimeImpactRevision({
			openClawProviderProjection: "json-patch",
			patch: providerProjectionProgramImpact(
				"openclaw",
				JSON.parse(providerPatch.content) as unknown,
				projectionInput,
			),
		});
	}
	return applyHostedHermesAiProviderProjection(
		observation,
		projectionInput,
		previousProviderIds,
		home,
		home,
		false,
	).revision;
}

function providerProjectionProgramImpact(
	runtime: "openclaw" | "hermes",
	patch: unknown,
	projectionInput: HostedAiProviderProjectionInput,
): unknown {
	const root = recordValue(patch);
	const managedProviderIds = new Set(
		projectionInput.catalog.providers
			.filter((provider) => provider.managed_by === "clawdi")
			.map((provider) => provider.id),
	);
	if (!root || managedProviderIds.size === 0) return patch;

	const providerContainer = runtime === "openclaw" ? recordValue(root.models) : root;
	if (!providerContainer) return patch;
	const providers = recordValue(providerContainer.providers);
	if (!providers) return patch;
	const programProviders = Object.fromEntries(
		Object.entries(providers).map(([providerId, provider]) => {
			const providerConfig = recordValue(provider);
			if (!managedProviderIds.has(providerId) || !providerConfig) return [providerId, provider];
			const { models: _models, ...programConfig } = providerConfig;
			return [providerId, programConfig];
		}),
	);
	if (runtime === "openclaw") {
		return { ...root, models: { ...providerContainer, providers: programProviders } };
	}
	return { ...root, providers: programProviders };
}

function applyHostedCodexManagedProviderProjection(
	manifest: RuntimeManifest,
	home: string,
	codexCli: Record<string, string> | null,
): HostedAiProviderProjectionResult {
	const provider = hostedCodexManagedProvider(manifest);
	if (!provider) return { path: null, revision: null, providerIds: [] };

	const codexHome = hostedCodexHome(home);
	enforceRuntimeUserOwnership(
		runtimeUserDirectoryOwnership(codexHome, { mode: 0o700, ancestorsUnder: home }),
	);
	const configPath = join(codexHome, CODEX_MANAGED_PROVIDER_CONFIG_FILE);
	const configContent = hostedCodexManagedConfigToml(provider);
	writePrivateFileAtomic(configPath, configContent, { mode: 0o600, dirMode: 0o700 });
	makeRuntimeUserOwned(configPath);
	enforceRuntimeUserOwnership(
		runtimeUserDirectoryOwnership(codexHome, { mode: 0o700, ancestorsUnder: home }),
	);

	return {
		path: configPath,
		providerIds: [CODEX_MANAGED_PROVIDER_ID],
		revision: runtimeImpactRevision({
			codexManagedProviderProjection: CODEX_MANAGED_PROVIDER_CONFIG_FILE,
			configContent,
			codexCli,
		}),
	};
}

function assertHostedProviderProjectionMode(
	runtimeName: string,
	manifest: RuntimeManifest,
	projectionInput: HostedAiProviderProjectionInput | null,
): void {
	const providerMode = manifest.runtimes[runtimeName]?.providerMode;
	if (providerMode === "unmanaged" && projectionInput) {
		throw new Error(`runtime ${runtimeName} unmanaged provider mode has a provider projection`);
	}
}

function hostedCodexManagedProvider(manifest: RuntimeManifest): HostedCodexManagedProvider | null {
	const terminalTooling = recordValue(manifest.projection?.terminalTooling);
	const codex = recordValue(terminalTooling?.codex);
	const provider = recordValue(codex?.provider);
	const primaryModel = recordValue(codex?.primary_model);
	const providerId = stringValue(codex?.provider_id);
	const baseUrl = stringValue(provider?.baseUrl);
	const apiMode = stringValue(provider?.apiMode);
	// Manifest v1 keeps this field so older CLIs can parse and self-upgrade; Codex chooses its model.
	const compatibilityModel = stringValue(primaryModel?.model);
	if (
		codex?.enabled !== true ||
		!provider ||
		provider.managed_by !== "clawdi" ||
		apiMode !== "openai_responses" ||
		!isHostedCodexManagedRuntimeEnv(stringValue(provider.runtimeEnvName)) ||
		normalizeSecretRef(stringValue(provider.apiKeySecretRef)) !== "secret://tool.codex.apiKey" ||
		!providerId ||
		stringValue(primaryModel?.provider_id) !== providerId ||
		!baseUrl ||
		!compatibilityModel
	) {
		return null;
	}
	return { baseUrl };
}

function hostedCodexHome(home: string): string {
	return join(home, ".codex");
}

function hostedCodexManagedConfigToml(provider: HostedCodexManagedProvider): string {
	const lines = ["# Generated by Clawdi hosted runtime. Do not put API keys in this file."];
	lines.push(
		`model_provider = ${quoteTomlString(CODEX_MANAGED_PROVIDER_ID)}`,
		"",
		`[model_providers.${CODEX_MANAGED_PROVIDER_ID}]`,
		`name = ${quoteTomlString("clawdi")}`,
		`base_url = ${quoteTomlString(provider.baseUrl)}`,
		`env_key = ${quoteTomlString(MANAGED_AI_PROVIDER_RUNTIME_ENV)}`,
		'wire_api = "responses"',
		"",
	);
	return lines.join("\n");
}

function ensureHostedCodexCli(paths: RuntimePaths): Record<string, string> | null {
	if (process.env.CLAWDI_CODEX_INSTALL_DISABLED === "1") return null;
	const npmPrefix = paths.userNpmPrefix;
	const realBin = join(npmPrefix, "bin", "codex");
	removeLegacyHostedCodexCommandShim(realBin, paths.userHome);
	let installedVersion = hostedCodexInstalledVersion(npmPrefix);
	const bootstrapRequired = installedVersion === null || !executableExists(realBin);
	if (bootstrapRequired) {
		installHostedCodexBootstrap(CODEX_BOOTSTRAP_PACKAGE_SPEC, npmPrefix, paths);
		installedVersion = hostedCodexInstalledVersion(npmPrefix);
		if (installedVersion !== CODEX_BOOTSTRAP_PACKAGE_VERSION) {
			throw new Error(
				`Codex bootstrap installed version ${installedVersion ?? "unknown"}; expected ${CODEX_BOOTSTRAP_PACKAGE_VERSION}`,
			);
		}
		if (!executableExists(realBin)) {
			throw new Error(`Codex bootstrap did not create ${realBin}`);
		}
	}
	if (installedVersion === null) throw new Error("Codex package metadata is unavailable");
	return {
		commandPath: realBin,
		npmPrefix,
		bootstrapPackageSpec: CODEX_BOOTSTRAP_PACKAGE_SPEC,
		installedVersion,
		realBin,
	};
}

function hostedCodexInstalledVersion(npmPrefix: string): string | null {
	const packageJsonPath = join(
		npmPrefix,
		"lib",
		"node_modules",
		"@openai",
		"codex",
		"package.json",
	);
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || !("version" in parsed)) return null;
		return typeof parsed.version === "string" && isValidSemver(parsed.version)
			? parsed.version
			: null;
	} catch {
		return null;
	}
}

function installHostedCodexBootstrap(
	packageSpec: string,
	npmPrefix: string,
	paths: RuntimePaths,
): void {
	if (!commandExists("npm")) {
		throw new Error("Codex bootstrap requires npm on PATH");
	}
	withRuntimeUserFileAccess(() => mkdirSync(npmPrefix, { recursive: true }));
	const result = spawnRuntimeUserCommand(
		"npm",
		[
			"install",
			"-g",
			"--prefix",
			npmPrefix,
			"--ignore-scripts",
			"--fetch-retries",
			"2",
			"--fetch-retry-mintimeout",
			"1000",
			"--fetch-retry-maxtimeout",
			"10000",
			"--fetch-timeout",
			"60000",
			"--omit=dev",
			"--no-audit",
			"--no-fund",
			"--no-update-notifier",
			packageSpec,
		],
		paths.userHome,
		paths.userHome,
		{ timeoutMs: 600_000 },
	);
	if (result.status !== 0) {
		throw new Error(
			`Codex bootstrap failed: ${tail(result.stderr?.toString()) ?? tail(result.stdout?.toString()) ?? "npm failed"}`,
		);
	}
}

function removeLegacyHostedCodexCommandShim(commandPath: string, home: string): void {
	let content: string;
	try {
		content = readFileSync(commandPath, "utf8");
	} catch {
		// A missing or unreadable command is handled by the normal bootstrap check.
		return;
	}
	const legacyRealBin = join(home, ".local", "share", "clawdi", "codex", "bin", "codex");
	const expected = [
		"#!/usr/bin/env sh",
		`export ${MANAGED_AI_PROVIDER_RUNTIME_ENV}='${MANAGED_EGRESS_PLACEHOLDER_VALUE}'`,
		`exec '${legacyRealBin}' "$@"`,
		"",
	].join("\n");
	if (content === expected) {
		withRuntimeUserFileAccess(() => rmSync(commandPath));
	}
}

function applyHostedHermesAiProviderProjection(
	observation: RuntimeInstallObservation,
	projectionInput: HostedAiProviderProjectionInput | null,
	previousProviderIds: readonly string[],
	home: string,
	workspaceRoot: string,
	apply = true,
): HostedAiProviderProjectionResult {
	const configPath = join(home, ".hermes", "config.yaml");
	if (apply) removeLegacyHermesModelProviderPlugin(home);
	if (!projectionInput) {
		const deletedProviderIds = staleProviderIds(new Set(previousProviderIds), new Set());
		if (apply && deletedProviderIds.length > 0) {
			applyHermesProviderConfig(
				hermesConfigContext(observation, home, workspaceRoot),
				{},
				deletedProviderIds,
			);
		}
		return {
			path: null,
			providerIds: [],
			revision: runtimeImpactRevision({
				hermesProviderProjection: "none",
				deletedProviderIds,
			}),
		};
	}

	const commandPath = observation.commandPath;
	if (!commandPath) return { path: null, revision: null, providerIds: [] };
	const projection = buildAgentTargetProjection(
		"hermes",
		projectionInput.catalog,
		projectionInput.primaryModel,
		{ freezeManagedModelCatalog: true },
	);
	const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
	if (!file) throw new Error("Hermes projection did not include a config merge YAML file.");
	const activeProviderIds = [...providerIdsFromPatch("hermes", file.content)].sort();
	const deletedProviderIds = staleProviderIds(
		new Set(previousProviderIds),
		new Set(activeProviderIds),
	);
	const patchContent = mergeProviderDeletes("hermes", file.content, deletedProviderIds);
	if (apply) {
		const patch = parseYaml(file.content) as unknown;
		const root = recordValue(patch);
		if (!root) throw new Error("Hermes projection patch must be a YAML object.");
		applyHermesProviderConfig(
			hermesConfigContext(observation, home, workspaceRoot),
			root,
			deletedProviderIds,
		);
	}
	return {
		path: configPath,
		providerIds: activeProviderIds,
		revision: runtimeImpactRevision({
			hermesProviderProjection: "yaml-merge",
			patch: providerProjectionProgramImpact("hermes", parseYaml(patchContent), projectionInput),
		}),
	};
}

function quoteTomlString(value: string): string {
	return JSON.stringify(value);
}

function legacyHermesModelProviderPluginDir(home: string): string {
	return join(home, ".hermes", "plugins", "model-providers", "clawdi");
}

// SUNSET: Remove after every fleet host has migrated to native Hermes provider projection.
function removeLegacyHermesModelProviderPlugin(home: string): void {
	withRuntimeUserFileAccess(() =>
		rmSync(legacyHermesModelProviderPluginDir(home), { recursive: true, force: true }),
	);
}

export interface OpenClawHostedProviderPatch {
	apply: boolean;
	args: string[];
	content: string;
	providerIds: string[];
}

const OPENCLAW_CONFIG_MUTATION_HELPER = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const sdk = await import(pathToFileURL(process.argv[1]).href);
if (
  typeof sdk.readConfigFileSnapshotForWrite !== "function" ||
  typeof sdk.mutateConfigFile !== "function"
) {
  throw new Error("required public config-mutation export is missing");
}
const patch = JSON.parse(readFileSync(0, "utf8"));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
if (!isRecord(patch)) throw new Error("OpenClaw provider patch must be an object");
const blockedKeys = new Set(["__proto__", "constructor", "prototype"]);
const explicitSetPaths = [];
const unsetPaths = [];
const applyMergePatch = (target, source, path = []) => {
  for (const [key, value] of Object.entries(source)) {
    if (blockedKeys.has(key)) throw new Error("OpenClaw provider patch contains a blocked key");
    const nextPath = [...path, key];
    if (value === null) {
      delete target[key];
      unsetPaths.push(nextPath);
    } else if (path.length === 2 && path[0] === "models" && path[1] === "providers") {
      target[key] = structuredClone(value);
      explicitSetPaths.push(nextPath);
    } else if (isRecord(value)) {
      if (!isRecord(target[key])) target[key] = {};
      if (Object.keys(value).length === 0) explicitSetPaths.push(nextPath);
      applyMergePatch(target[key], value, nextPath);
    } else {
      target[key] = structuredClone(value);
      explicitSetPaths.push(nextPath);
    }
  }
};
const configRead = await sdk.readConfigFileSnapshotForWrite({ skipPluginValidation: true });
const snapshot = configRead?.snapshot;
if (!snapshot || snapshot.valid !== true || !isRecord(snapshot.sourceConfig)) {
  throw new Error("OpenClaw config snapshot is unavailable for provider projection");
}
const projected = structuredClone(snapshot.sourceConfig);
applyMergePatch(projected, patch);
if (isDeepStrictEqual(projected, snapshot.sourceConfig)) process.exit(0);
explicitSetPaths.length = 0;
unsetPaths.length = 0;
await sdk.mutateConfigFile({
  base: "source",
  afterWrite: { mode: "none", reason: "Clawdi runtime convergence owns service reconciliation" },
  writeOptions: { allowConfigSizeDrop: true, explicitSetPaths, unsetPaths },
  mutate: (draft) => applyMergePatch(draft, patch),
});
`;

function applyOpenClawHostedProviderPatch(
	observation: RuntimeInstallObservation,
	patch: OpenClawHostedProviderPatch,
	context: OpenClawHostedContext,
	workspaceRoot: string,
): void {
	const sdkPath = context.sdk.configMutation;
	if (!sdkPath) {
		runRuntimeUserCommand(
			observation.commandPath ?? "openclaw",
			["config", "patch", "--stdin", ...patch.args],
			patch.content,
			context.home,
			workspaceRoot,
		);
		return;
	}
	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(context.home));
	runRuntimeUserCommand(
		"node",
		["--input-type=module", "--eval", OPENCLAW_CONFIG_MUTATION_HELPER, sdkPath],
		patch.content,
		context.home,
		workspaceRoot,
	);
}

export function buildOpenClawHostedProviderPatch(
	projectionInput: HostedAiProviderProjectionInput | null,
	previousProviderIds: readonly string[],
): OpenClawHostedProviderPatch {
	if (!projectionInput) {
		const deletedProviderIds = staleProviderIds(new Set(previousProviderIds), new Set());
		return {
			apply: deletedProviderIds.length > 0,
			args: [],
			content: `${JSON.stringify(openClawProviderDeletePatch(deletedProviderIds), null, 2)}\n`,
			providerIds: [],
		};
	}
	const projection = buildAgentTargetProjection(
		"openclaw",
		projectionInput.catalog,
		projectionInput.primaryModel,
	);
	const file = projection.files.find((entry) => entry.path.endsWith(".openclaw.json"));
	if (!file) throw new Error("OpenClaw projection did not include a config patch JSON file.");
	const providerIds = [...providerIdsFromPatch("openclaw", file.content)].sort();
	const deletedProviderIds = staleProviderIds(new Set(previousProviderIds), new Set(providerIds));
	const providerPatchContent =
		providerIds.length > 0 ? withOpenClawProviderMode(file.content, "replace") : file.content;
	return {
		apply: true,
		args: openClawProviderReplacementArgs(file.content),
		content: mergeProviderDeletes("openclaw", providerPatchContent, deletedProviderIds),
		providerIds,
	};
}

type ProviderPatchRuntime = "hermes" | "openclaw";

function providerPatchRoot(
	runtime: ProviderPatchRuntime,
	content: string,
): Record<string, unknown> | null {
	if (runtime === "hermes" && !content.trim()) return null;
	return recordValue(runtime === "openclaw" ? JSON.parse(content) : parseYaml(content));
}

function providerPatchProviders(
	runtime: ProviderPatchRuntime,
	root: Record<string, unknown>,
): Record<string, unknown> | null {
	const container = runtime === "openclaw" ? recordValue(root.models) : root;
	return container ? recordValue(container.providers) : null;
}

function providerIdsFromPatch(runtime: ProviderPatchRuntime, content: string): Set<string> {
	const root = providerPatchRoot(runtime, content);
	const providers = root ? providerPatchProviders(runtime, root) : null;
	if (!providers) return new Set();
	return new Set(
		Object.entries(providers)
			.filter(([, value]) => value !== null)
			.map(([providerId]) => providerId),
	);
}

function openClawProviderReplacementArgs(content: string): string[] {
	const parsed = JSON.parse(content) as unknown;
	const root = recordValue(parsed);
	const models = root ? recordValue(root.models) : null;
	const providers = models ? recordValue(models.providers) : null;
	if (!providers) return [];
	return Object.entries(providers).flatMap(([providerId, provider]) => {
		const providerConfig = recordValue(provider);
		if (!providerConfig) return [];
		return ["--replace-path", `models.providers[${JSON.stringify(providerId)}]`];
	});
}

function withOpenClawProviderMode(patchContent: string, mode: "merge" | "replace"): string {
	const parsed = JSON.parse(patchContent) as unknown;
	const root = recordValue(parsed);
	if (!root) return patchContent;
	const patch = { ...root };
	const models = { ...(recordValue(patch.models) ?? {}), mode };
	patch.models = models;
	return `${JSON.stringify(patch, null, 2)}\n`;
}
function openClawProviderDeletePatch(
	deletedProviderIds: readonly string[],
): Record<string, unknown> {
	return {
		models: {
			mode: "merge",
			providers: Object.fromEntries(deletedProviderIds.map((providerId) => [providerId, null])),
		},
	};
}

const HERMES_DIRECT_MODEL_FIELDS = [
	"base_url",
	"api_key",
	"api",
	"key_env",
	"api_mode",
	"auth_mode",
] as const;
const HERMES_GENERATED_PROVIDER_FIELDS = [
	"name",
	"api",
	"url",
	"base_url",
	"default_model",
	"model",
	"models",
	"discover_models",
	"transport",
	"api_mode",
	"key_env",
	"api_key",
	"type",
	"auth_type",
] as const;

function applyHermesProviderConfig(
	context: HermesConfigCommandContext,
	patch: Record<string, unknown>,
	deletedProviderIds: readonly string[],
): void {
	const patchModel = recordValue(patch.model) ?? {};
	const modelKeys = new Set<string>([...HERMES_DIRECT_MODEL_FIELDS, ...Object.keys(patchModel)]);
	for (const key of [...modelKeys].sort()) {
		const value = Object.hasOwn(patchModel, key) ? patchModel[key] : undefined;
		reconcileHermesConfigValue(context, `model.${key}`, value === null ? undefined : value);
	}
	if (!Object.hasOwn(patchModel, "provider") && deletedProviderIds.length > 0) {
		const currentProvider = getHermesResolvedConfigValue(context, "model.provider");
		if (currentProvider.exists && typeof currentProvider.value !== "string") {
			throw new Error("Hermes config field model.provider must be a string");
		}
		const managedSelectors = new Set(
			deletedProviderIds.flatMap((providerId) => [providerId, `custom:${providerId}`]),
		);
		if (currentProvider.exists && managedSelectors.has(currentProvider.value as string)) {
			reconcileHermesConfigValue(context, "model.provider", undefined);
			if (!Object.hasOwn(patchModel, "default")) {
				reconcileHermesConfigValue(context, "model.default", undefined);
			}
		}
	}

	const currentValue = getHermesRawConfigValue(context, "providers");
	if (currentValue.exists && !isPlainRecord(currentValue.value)) {
		throw new Error("Hermes config field providers must be an object");
	}
	const currentProviders: Record<string, unknown> =
		currentValue.exists && isPlainRecord(currentValue.value) ? currentValue.value : {};
	for (const [providerId, provider] of Object.entries(currentProviders)) {
		if (provider !== undefined && provider !== null && !isPlainRecord(provider)) {
			throw new Error(`Hermes provider ${providerId} must be an object`);
		}
	}
	const nextProviders: Record<string, unknown> = { ...currentProviders };
	for (const providerId of deletedProviderIds) delete nextProviders[providerId];

	const patchProviders = recordValue(patch.providers) ?? {};
	for (const [providerId, providerPatch] of Object.entries(patchProviders)) {
		if (providerPatch === null) {
			delete nextProviders[providerId];
			continue;
		}
		if (!isPlainRecord(providerPatch)) continue;
		const existingProvider = nextProviders[providerId];
		if (
			existingProvider !== undefined &&
			existingProvider !== null &&
			!isPlainRecord(existingProvider)
		) {
			throw new Error(`Hermes provider ${providerId} must be an object`);
		}
		const nextProvider: Record<string, unknown> = isPlainRecord(existingProvider)
			? { ...existingProvider }
			: {};
		for (const key of HERMES_GENERATED_PROVIDER_FIELDS) delete nextProvider[key];
		let wroteGeneratedField = false;
		for (const [key, value] of Object.entries(providerPatch)) {
			if (value === null) {
				delete nextProvider[key];
				continue;
			}
			nextProvider[key] = value;
			wroteGeneratedField = true;
		}
		const hasUserOwnedField = Object.keys(nextProvider).some(
			(key) => !(HERMES_GENERATED_PROVIDER_FIELDS as readonly string[]).includes(key),
		);
		if (wroteGeneratedField || hasUserOwnedField) nextProviders[providerId] = nextProvider;
		else delete nextProviders[providerId];
	}

	if (Object.keys(nextProviders).length === 0 && Object.keys(currentProviders).length === 0) return;
	reconcileHermesConfigValue(
		context,
		"providers",
		Object.keys(nextProviders).length > 0 ? nextProviders : undefined,
	);
}

function mergeProviderDeletes(
	runtime: ProviderPatchRuntime,
	patchContent: string,
	deletedProviderIds: readonly string[],
): string {
	if (deletedProviderIds.length === 0) return patchContent;
	const root = providerPatchRoot(runtime, patchContent);
	if (!root) return patchContent;
	const patch = { ...root };
	const container =
		runtime === "openclaw" ? { ...(recordValue(patch.models) ?? { mode: "merge" }) } : patch;
	const existingProviders = recordValue(container.providers);
	const providers = existingProviders ? { ...existingProviders } : {};
	for (const providerId of deletedProviderIds) {
		providers[providerId] = null;
	}
	container.providers = providers;
	if (runtime === "openclaw") patch.models = container;
	return runtime === "openclaw"
		? `${JSON.stringify(patch, null, 2)}\n`
		: `${stringifyYaml(patch).trimEnd()}\n`;
}

function staleProviderIds(
	previousProviderIds: Set<string>,
	activeProviderIds: Set<string>,
): string[] {
	return [...previousProviderIds]
		.filter((providerId) => !activeProviderIds.has(providerId))
		.sort((left, right) => left.localeCompare(right));
}

function openClawGatewayHostedPatch(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	ownerBrowserBootstrapSupported: boolean,
): Record<string, unknown> | null {
	const allowedOrigins = openClawControlUiAllowedOrigins(manifest);
	const gatewayToken = manifest.openclawGatewayAuth
		? runtimeSecretValue(secretValues ?? {}, manifest.openclawGatewayAuth.tokenRef)
		: null;
	const isHostedV2 =
		manifest.projection?.sourceBundleVersion === HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION;
	const nativeAuth = isHostedV2 ? manifest.openclawGatewayAuth : undefined;
	if (isHostedV2 && nativeAuth?.activation.enabled !== true) {
		throw new Error("OpenClaw native auth capability is unavailable");
	}
	if (manifest.openclawGatewayAuth && !gatewayToken) {
		throw new Error("OpenClaw native gateway token is unavailable");
	}
	if (allowedOrigins.length === 0 && !gatewayToken && !manifest.locale) return null;
	return {
		...(manifest.locale
			? {
					agents: {
						defaults: {
							userTimezone: manifest.locale.timezone,
						},
					},
				}
			: {}),
		gateway: {
			mode: "local",
			...(gatewayToken || allowedOrigins.length > 0
				? {
						...(nativeAuth ? { port: 18789, bind: "lan" } : {}),
						...(gatewayToken
							? {
									auth: {
										mode: "token",
										token: gatewayToken,
									},
								}
							: {}),
						...(allowedOrigins.length > 0
							? {
									controlUi: {
										allowedOrigins,
										...(nativeAuth
											? {
													basePath: openClawControlUiBasePath(manifest),
													dangerouslyAllowHostHeaderOriginFallback: false,
													dangerouslyDisableDeviceAuth: ownerBrowserBootstrapSupported
														? null
														: true,
												}
											: {}),
									},
								}
							: {}),
					}
				: {}),
		},
	};
}

function jsonMergePatchIsApplied(current: unknown, patch: unknown): boolean {
	if (!isPlainRecord(patch)) return canonicalJsonEqual(current, patch);
	if (!isPlainRecord(current)) return false;
	return Object.entries(patch).every(([key, value]) =>
		value === undefined
			? true
			: value === null
				? !Object.hasOwn(current, key)
				: jsonMergePatchIsApplied(current[key], value),
	);
}

function openClawConfigPatchIsApplied(
	context: OpenClawHostedContext,
	patch: Record<string, unknown>,
): boolean {
	try {
		const current = JSON.parse(readFileSync(context.configPath, "utf-8")) as unknown;
		return jsonMergePatchIsApplied(current, patch);
	} catch {
		return false;
	}
}

function openClawControlUiBasePath(manifest: RuntimeManifest): string {
	const system = manifest.projection?.system;
	if (!isPlainRecord(system)) return "/";
	const value = system.openclawControlUiBasePath;
	if (typeof value !== "string" || !value.startsWith("/")) return "/";
	return value === "/" ? "/" : value.replace(/\/$/, "");
}

function applyOpenClawGatewayHostedProjection(
	command: string,
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	context: OpenClawHostedContext,
	workspaceRoot: string,
	ownerBrowserBootstrapSupported: boolean,
): void {
	const patch = openClawGatewayHostedPatch(manifest, secretValues, ownerBrowserBootstrapSupported);
	if (!patch || openClawConfigPatchIsApplied(context, patch)) return;
	runRuntimeUserCommand(
		command,
		["config", "patch", "--stdin"],
		`${JSON.stringify(patch, null, 2)}\n`,
		context.home,
		workspaceRoot,
	);
}

function openClawControlUiAllowedOrigins(manifest: RuntimeManifest): string[] {
	const system = manifest.projection?.system;
	if (!isPlainRecord(system)) return [];
	const raw = system.openclawControlUiAllowedOrigins;
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const origins: string[] = [];
	for (const value of raw) {
		if (typeof value !== "string") continue;
		const origin = value.trim();
		if (!origin || seen.has(origin)) continue;
		seen.add(origin);
		origins.push(origin);
	}
	return origins;
}

function hostedChannelProjection(manifest: RuntimeManifest): Record<string, unknown> | null {
	if (!manifest.projection || !Object.hasOwn(manifest.projection, "channels")) {
		return null;
	}
	const channels = manifest.projection.channels;
	if (!isPlainRecord(channels)) return null;
	return channels;
}

function applyHermesNestedConfigPatch(
	context: HermesConfigCommandContext,
	prefix: string,
	patch: Record<string, unknown>,
): boolean {
	let changed = false;
	for (const [key, value] of Object.entries(patch).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const path = `${prefix}.${key}`;
		if (isPlainRecord(value)) {
			changed = applyHermesNestedConfigPatch(context, path, value) || changed;
			continue;
		}
		changed =
			reconcileHermesConfigValue(context, path, value === null ? undefined : value) || changed;
	}
	return changed;
}

function applyHermesChannelConfig(
	context: HermesConfigCommandContext,
	patch: Record<string, unknown>,
): boolean {
	let changed = false;
	for (const [key, value] of Object.entries(patch).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (key === "telegram" || key === "discord") {
			changed = reconcileHermesConfigValue(context, key, value) || changed;
			continue;
		}
		if (key === "whatsapp" || key === "display") {
			if (!isPlainRecord(value))
				throw new Error(`Hermes channel patch field ${key} must be an object`);
			changed = applyHermesNestedConfigPatch(context, key, value) || changed;
			continue;
		}
		if (key === "platforms") {
			if (!isPlainRecord(value)) {
				throw new Error("Hermes channel patch field platforms must be an object");
			}
			for (const [platform, platformConfig] of Object.entries(value).sort(([left], [right]) =>
				left.localeCompare(right),
			)) {
				if ((platform === "telegram" || platform === "whatsapp") && isPlainRecord(platformConfig)) {
					changed =
						applyHermesNestedConfigPatch(context, `platforms.${platform}`, platformConfig) ||
						changed;
				} else {
					changed =
						reconcileHermesConfigValue(context, `platforms.${platform}`, platformConfig) || changed;
				}
			}
			continue;
		}
		changed =
			reconcileHermesConfigValue(context, key, value === null ? undefined : value) || changed;
	}
	return changed;
}

function applyHostedChannelProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	openClawContext: OpenClawHostedContext,
	workspaceRoot: string,
	hermesWhatsAppAuthDir: string | null,
): boolean {
	if (name !== "openclaw" && name !== "hermes") return false;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return false;
	}
	const channels = hostedChannelProjection(manifest);
	if (!channels) return false;

	if (name === "hermes") {
		return applyHermesChannelConfig(
			hermesConfigContext(observation, home, workspaceRoot),
			buildHermesManagedChannelsPatch(channels, hermesWhatsAppAuthDir),
		);
	}
	const patch = openClawManagedChannelsPatch(channels);
	if (openClawConfigPatchIsApplied(openClawContext, patch)) return false;
	runRuntimeUserCommand(
		observation.commandPath,
		["config", "patch", "--stdin", ...openClawManagedAccountReplaceArgs(channels)],
		`${JSON.stringify(patch, null, 2)}\n`,
		home,
		workspaceRoot,
	);
	return true;
}

function installHostedChannelProjectionDependencies(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	workspaceRoot: string,
	previousReceipts: RuntimeInstallReceipts | null,
	receiptTargets: RuntimeInstallReceiptTargets,
): void {
	if (name !== "openclaw") return;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return;
	}
	const channels = hostedChannelProjection(manifest);
	if (!channels) return;
	installOpenClawChannelPlugins({
		commandPath: observation.commandPath,
		channels,
		home,
		workspaceRoot,
		previousReceipts,
		receiptTargets,
	});
}

function openClawManagedChannelUsesEnvSecretRefs(channels: Record<string, unknown>): boolean {
	return ["telegram", "discord", "whatsapp"].some((channel) =>
		managedChannelHasAccounts(channels[channel]),
	);
}

function openClawManagedChannelsPatch(channels: Record<string, unknown>): Record<string, unknown> {
	const deleteEntries = openClawManagedChannelDeletes();
	const usesEnvSecretRefs = openClawManagedChannelUsesEnvSecretRefs(channels);
	const isolatesManagedDms =
		managedChannelHasAccounts(channels.telegram) ||
		managedChannelHasAccounts(channels.discord) ||
		managedChannelHasAccounts(channels.whatsapp);
	return {
		channels: {
			...deleteEntries,
			...channels,
		},
		plugins: {
			entries: {
				...deleteEntries,
				...channelPluginEntries(channels),
			},
		},
		secrets: usesEnvSecretRefs
			? {
					providers: {
						default: { source: "env" },
					},
					defaults: {
						env: "default",
					},
				}
			: undefined,
		session: {
			dmScope: isolatesManagedDms ? "per-account-channel-peer" : null,
		},
	};
}

function openClawManagedAccountReplaceArgs(channels: Record<string, unknown>): string[] {
	const args: string[] = [];
	for (const provider of OPENCLAW_MANAGED_CHANNELS) {
		const channel = channels[provider];
		if (!isPlainRecord(channel) || !isPlainRecord(channel.accounts)) continue;
		args.push("--replace-path", `channels.${provider}.accounts`);
	}
	return args;
}

function openClawManagedChannelDeletes(): Record<string, null> {
	return Object.fromEntries(OPENCLAW_MANAGED_CHANNELS.map((channel) => [channel, null])) as Record<
		string,
		null
	>;
}

function installOpenClawChannelPlugins(input: {
	commandPath: string;
	channels: Record<string, unknown>;
	home: string;
	workspaceRoot: string;
	previousReceipts: RuntimeInstallReceipts | null;
	receiptTargets: RuntimeInstallReceiptTargets;
}): void {
	for (const channel of Object.keys(input.channels).sort()) {
		const specs = OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS[channel];
		if (!specs) continue;
		const key = `openclaw:${channel}`;
		const desiredRevision = channelPluginDesiredRevision({
			channel,
			specs,
		});
		const currentRevision = () =>
			channelPluginCurrentRevision({
				channel,
				specs,
				commandPath: input.commandPath,
				home: input.home,
				workspaceRoot: input.workspaceRoot,
			});
		const verifiedCurrentRevision = verifiedReceiptCurrentRevision(
			input.previousReceipts?.channelPlugins[key],
			desiredRevision,
			currentRevision,
		);
		const target: RuntimeInstallReceiptTarget = {
			desiredRevision,
			currentRevision,
			expectedCurrentRevision: verifiedCurrentRevision,
		};
		input.receiptTargets.channelPlugins.set(key, target);
		if (verifiedCurrentRevision !== null) continue;
		runPluginInstallWithFallback(input.commandPath, specs, input.home, input.workspaceRoot);
		const installedRevision = currentRevision();
		if (!installedRevision) {
			throw new Error(`OpenClaw ${channel} channel plugin install could not be verified`);
		}
		target.expectedCurrentRevision = installedRevision;
	}
}

function runPluginInstallWithFallback(
	commandPath: string,
	specs: readonly string[],
	home: string,
	workspaceRoot: string,
): void {
	let lastError: unknown = null;
	for (const spec of specs) {
		try {
			runRuntimeUserCommand(
				commandPath,
				["plugins", "install", spec, "--force"],
				"",
				home,
				workspaceRoot,
			);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error(`OpenClaw plugin install failed for ${specs.join(" or ")}`);
}

function channelPluginEntries(
	channels: Record<string, unknown>,
): Record<string, { enabled: boolean }> {
	const entries: Record<string, { enabled: boolean }> = {};
	for (const channel of Object.keys(channels).sort()) {
		entries[channel] = { enabled: true };
	}
	return entries;
}

function hostedMcpProjectionDeclared(manifest: RuntimeManifest): boolean {
	return manifest.projection?.mcp !== undefined;
}

interface HostedMcpIntent {
	servers: Record<string, HostedMcpServerDesiredState>;
}

const HOSTED_RUNTIME_TARGETS = ["openclaw", "hermes"] as const satisfies readonly RuntimeName[];
// SUNSET: Remove v1 parsing and the projection-root fallback after every fleet host has written the v2 managed-resource ledger.
const HOSTED_MCP_LEDGER_V1_SCHEMA_VERSION = "clawdi.hostedManagedMcpServers.v1";
const HOSTED_MCP_LEDGER_SCHEMA_VERSION = "clawdi.hostedManagedMcpServers.v2";
const HOSTED_MCP_LEDGER_FILE = "managed-mcp-servers.json";
const HOSTED_MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface HostedMcpManagedLedger {
	schemaVersion: typeof HOSTED_MCP_LEDGER_SCHEMA_VERSION;
	runtimes: Partial<Record<(typeof HOSTED_RUNTIME_TARGETS)[number], string[]>>;
}

function hostedMcpIntent(manifest: RuntimeManifest): HostedMcpIntent {
	const value = manifest.projection?.mcp;
	if (value === undefined) return { servers: {} };
	return { servers: hostedMcpDesiredStateSchema.parse(value).servers };
}

function hostedMcpLedgerPath(paths: RuntimePaths): string {
	return join(paths.managedResourceRoot, HOSTED_MCP_LEDGER_FILE);
}

function legacyHostedMcpLedgerPath(paths: RuntimePaths): string {
	return join(paths.projectionRoot, HOSTED_MCP_LEDGER_FILE);
}

function readHostedMcpManagedLedger(paths: RuntimePaths): HostedMcpManagedLedger {
	const path = hostedMcpLedgerPath(paths);
	const legacyPath = legacyHostedMcpLedgerPath(paths);
	const sourcePath = existsSync(path) ? path : existsSync(legacyPath) ? legacyPath : null;
	if (!sourcePath) {
		return { schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION, runtimes: {} };
	}
	let payload: unknown;
	try {
		payload = JSON.parse(readFileSync(sourcePath, "utf-8"));
	} catch (error) {
		throw new Error(
			`hosted MCP last-applied ledger is invalid: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (
		!isPlainRecord(payload) ||
		(payload.schemaVersion !== HOSTED_MCP_LEDGER_V1_SCHEMA_VERSION &&
			payload.schemaVersion !== HOSTED_MCP_LEDGER_SCHEMA_VERSION)
	) {
		throw new Error("hosted MCP last-applied ledger has an unsupported schema");
	}
	if (
		Object.keys(payload).length !== 2 ||
		!Object.hasOwn(payload, "schemaVersion") ||
		!Object.hasOwn(payload, "runtimes")
	) {
		throw new Error("hosted MCP last-applied ledger has invalid fields");
	}
	const runtimes = recordValue(payload.runtimes);
	if (
		!runtimes ||
		Object.keys(runtimes).some((name) => !HOSTED_RUNTIME_TARGETS.includes(name as never))
	) {
		throw new Error("hosted MCP last-applied ledger has invalid runtimes");
	}
	const normalized: HostedMcpManagedLedger["runtimes"] = {};
	for (const runtime of HOSTED_RUNTIME_TARGETS) {
		const runtimeOwnership = runtimes[runtime];
		if (runtimeOwnership === undefined) continue;
		// V1 values are untrusted legacy desired state. Migrate ownership by name only.
		const names =
			payload.schemaVersion === HOSTED_MCP_LEDGER_V1_SCHEMA_VERSION
				? isPlainRecord(runtimeOwnership)
					? Object.keys(runtimeOwnership)
					: null
				: Array.isArray(runtimeOwnership)
					? runtimeOwnership
					: null;
		if (!names) {
			throw new Error(`hosted MCP last-applied ledger has invalid ${runtime} servers`);
		}
		const normalizedNames = new Set<string>();
		for (const name of names) {
			if (typeof name !== "string" || !HOSTED_MCP_SERVER_NAME_PATTERN.test(name)) {
				throw new Error(`hosted MCP last-applied ledger has invalid ${runtime} server name`);
			}
			if (normalizedNames.has(name)) {
				throw new Error(`hosted MCP last-applied ledger has duplicate ${runtime} server name`);
			}
			normalizedNames.add(name);
		}
		if (normalizedNames.size > 0) normalized[runtime] = [...normalizedNames].sort();
	}
	return { schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION, runtimes: normalized };
}

function writeHostedMcpManagedLedger(paths: RuntimePaths, ledger: HostedMcpManagedLedger): void {
	writeJsonFile(
		hostedMcpLedgerPath(paths),
		{
			schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION,
			runtimes: Object.fromEntries(
				HOSTED_RUNTIME_TARGETS.flatMap((runtime) => {
					const names = ledger.runtimes[runtime];
					return names && names.length > 0 ? [[runtime, [...names].sort()]] : [];
				}),
			),
		},
		paths,
	);
}

function hostedBundledSkillsEnabled(): boolean {
	return detectRuntimeMode() === "hosted";
}

type HostedSkillDesired =
	| { enabled: boolean; version: number }
	| { enabled: boolean; source: HostedSkillSource };

interface HostedSkillProjectionDriver {
	name: "hermes" | "openclaw";
	enabled: boolean;
	skillsRoot: string | null;
	install(
		skill: PreparedHostedSourcedSkill,
		previouslyReserved: boolean,
	): "installed" | "unchanged";
	hasOwnershipReceipt(skill: PreparedHostedSourcedSkill): boolean;
	remove(reservation: ManagedSkillReservationSnapshot, legacy: boolean): void;
}

function preparedSkillMatchesDesired(
	prepared: PreparedHostedSourcedSkill | undefined,
	desired: HostedSkillDesired,
	skillId: string,
): prepared is PreparedHostedSourcedSkill {
	if (!prepared || prepared.skillId !== skillId) return false;
	if ("source" in desired) {
		return JSON.stringify(prepared.source) === JSON.stringify(desired.source);
	}
	const catalogEntry = resolveHostedBundledSkill(skillId, desired.version);
	return (
		prepared.source.type === "bundled" &&
		prepared.source.version === desired.version &&
		prepared.source.digest === catalogEntry.digest &&
		prepared.source.assetDirectory === catalogEntry.assetDirectory
	);
}

function completePreparedHostedSkills(
	manifest: RuntimeManifest,
	prepared: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): ReadonlyMap<string, PreparedHostedSourcedSkill> {
	if (!hostedBundledSkillsEnabled()) return prepared;
	const complete = new Map(prepared);
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		if (!desired.enabled || "source" in desired) continue;
		const existing = complete.get(skillId);
		if (preparedSkillMatchesDesired(existing, desired, skillId)) continue;
		complete.set(skillId, prepareHostedBundledSkillArchive(skillId, desired.version));
	}
	return complete;
}

function preparedReservationIdentity(skill: PreparedHostedSourcedSkill): {
	version?: number;
	digest?: string;
	sourceIdentity?: string;
} {
	return skill.source.type === "bundled"
		? { version: skill.source.version, digest: skill.source.digest }
		: { sourceIdentity: skill.sourceIdentity };
}

function reservationOwnershipIdentity(reservation: ManagedSkillReservationSnapshot): string {
	if (reservation.sourceIdentity) return reservation.sourceIdentity;
	if (reservation.digest) return `content-sha256\0${reservation.digest}`;
	throw new Error(`managed Skill ${reservation.id} has no ownership identity`);
}

function hostedSkillProjectionDrivers(input: {
	manifest: RuntimeManifest;
	home: string;
	openClawWorkspaceRoot: string | null;
	hermesDriver: HostedHermesSkillExactSourceDriver;
	openClawDriver: HostedOpenClawSkillDriver;
}): HostedSkillProjectionDriver[] {
	const appRoot = join(input.home, ".hermes", "hermes-agent");
	const hermesSkillsRoot = join(input.home, ".hermes", "skills");
	const openClawSkillsRoot = input.openClawWorkspaceRoot
		? join(input.openClawWorkspaceRoot, "skills")
		: null;
	return [
		{
			name: "hermes",
			enabled: input.manifest.runtimes.hermes?.enabled === true,
			skillsRoot: hermesSkillsRoot,
			install: (skill, previouslyReserved) =>
				input.hermesDriver.install({
					home: input.home,
					appRoot,
					skill,
					previouslyReserved,
				}),
			hasOwnershipReceipt: (skill) =>
				input.hermesDriver.hasOwnershipReceipt({
					home: input.home,
					skillId: skill.skillId,
					ownershipIdentity: skill.sourceIdentity,
				}),
			remove: (reservation, legacy) => {
				if (legacy) {
					withRuntimeUserFileAccess(() =>
						rmSync(reservation.targetDir, { recursive: true, force: true }),
					);
					return;
				}
				const ownershipIdentity = reservationOwnershipIdentity(reservation);
				if (reservation.digest) {
					input.hermesDriver.cleanupManifestOwned({
						home: input.home,
						skillId: reservation.id,
						ownershipIdentity,
					});
					return;
				}
				input.hermesDriver.uninstall({
					home: input.home,
					appRoot,
					skillId: reservation.id,
					ownershipIdentity,
				});
			},
		},
		{
			name: "openclaw",
			enabled: input.manifest.runtimes.openclaw?.enabled === true,
			skillsRoot: openClawSkillsRoot,
			install: (skill, previouslyReserved) => {
				if (!input.openClawWorkspaceRoot) {
					throw new Error("OpenClaw official agent workspace is unavailable");
				}
				return input.openClawDriver.install({
					home: input.home,
					workspaceRoot: input.openClawWorkspaceRoot,
					skill,
					previouslyReserved,
				});
			},
			hasOwnershipReceipt: (skill) => {
				if (!input.openClawWorkspaceRoot) return false;
				return input.openClawDriver.hasOwnershipReceipt({
					workspaceRoot: input.openClawWorkspaceRoot,
					skillId: skill.skillId,
					ownershipIdentity: skill.sourceIdentity,
				});
			},
			remove: (reservation, legacy) => {
				if (!input.openClawWorkspaceRoot) {
					throw new Error("OpenClaw official agent workspace is unavailable");
				}
				if (legacy) {
					withRuntimeUserFileAccess(() =>
						rmSync(reservation.targetDir, { recursive: true, force: true }),
					);
					return;
				}
				input.openClawDriver.cleanupManifestOwned({
					workspaceRoot: input.openClawWorkspaceRoot,
					skillId: reservation.id,
					ownershipIdentity: reservationOwnershipIdentity(reservation),
				});
			},
		},
	];
}

function recoverHostedSkillReservations(
	driver: HostedSkillProjectionDriver,
	manifest: RuntimeManifest,
	preparedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): void {
	if (!hostedBundledSkillsEnabled() || !driver.skillsRoot) return;
	const desiredEntries = manifest.projection?.skills?.entries ?? {};
	const skillIds = new Set([...Object.keys(desiredEntries), ...hostedBundledSkillIds()]);
	for (const skillId of [...skillIds].sort()) {
		const targetDir = join(driver.skillsRoot, skillId);
		if (
			!existsSync(targetDir) ||
			managedSkillReservationOwner(targetDir, skillId) !== "unreserved"
		) {
			continue;
		}
		const legacy = adoptableLegacyHostedBundledSkill(targetDir, skillId);
		if (legacy) {
			reserveManagedSkill({
				targetDir,
				id: skillId,
				manager: "hosted-manifest",
				version: legacy.version,
				digest: legacy.digest,
			});
			continue;
		}
		const desired = desiredEntries[skillId];
		if (!driver.enabled || desired?.enabled !== true) continue;
		const prepared = preparedSkills.get(skillId);
		if (
			!preparedSkillMatchesDesired(prepared, desired, skillId) ||
			!driver.hasOwnershipReceipt(prepared)
		) {
			continue;
		}
		reserveManagedSkill({
			targetDir,
			id: skillId,
			manager: "hosted-manifest",
			...preparedReservationIdentity(prepared),
		});
	}
}

function validateHostedSkillsPlan(
	driver: HostedSkillProjectionDriver,
	manifest: RuntimeManifest,
	preparedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): void {
	if (!hostedBundledSkillsEnabled()) return;
	if (driver.enabled && !driver.skillsRoot) {
		throw new Error("OpenClaw official agent workspace is unavailable");
	}
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		if ("source" in desired && hostedBundledSkillIds().includes(skillId)) {
			throw new Error(`bundled hosted Skill ${skillId} must not declare a catalog source`);
		}
		if (!("source" in desired)) resolveHostedBundledSkill(skillId, desired.version);
		if (!driver.enabled || !driver.skillsRoot || !desired.enabled) continue;
		const prepared = preparedSkills.get(skillId);
		if (!preparedSkillMatchesDesired(prepared, desired, skillId)) {
			throw new Error(`pinned archive for hosted Skill ${skillId} is unavailable`);
		}
		const targetDir = join(driver.skillsRoot, skillId);
		if (
			existsSync(targetDir) &&
			managedSkillReservationOwner(targetDir, skillId) !== "hosted-manifest"
		) {
			throw new Error(`refusing to replace unmanaged ${skillId} skill at ${targetDir}`);
		}
	}
}

function applyHostedSkills(
	driver: HostedSkillProjectionDriver,
	observation: RuntimeInstallObservation | undefined,
	manifest: RuntimeManifest,
	preparedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): void {
	if (!hostedBundledSkillsEnabled() || !driver.skillsRoot) return;
	const desiredEntries = manifest.projection?.skills?.entries ?? {};
	const reservations = managedSkillReservations("hosted-manifest").filter(
		(reservation) => dirname(reservation.targetDir) === driver.skillsRoot,
	);
	const skillIds = new Set([
		...Object.keys(desiredEntries),
		...reservations.map((reservation) => reservation.id),
		...hostedBundledSkillIds(),
	]);
	for (const skillId of [...skillIds].sort()) {
		const targetDir = join(driver.skillsRoot, skillId);
		const desired = desiredEntries[skillId];
		if (!driver.enabled || desired?.enabled !== true) {
			const owner = managedSkillReservationOwner(targetDir, skillId);
			if (owner === "unreserved" || owner === "local-setup") continue;
			if (owner !== "hosted-manifest") {
				throw new Error(`managed Skill ${skillId} is owned by a different manager`);
			}
			const reservation = managedSkillReservations("hosted-manifest").find(
				(entry) => entry.targetDir === targetDir && entry.id === skillId,
			);
			if (!reservation) throw new Error(`managed Skill ${skillId} has no ownership reservation`);
			releaseManagedSkill({
				targetDir,
				id: skillId,
				manager: "hosted-manifest",
				removeTarget: () =>
					driver.remove(
						reservation,
						adoptableLegacyHostedBundledSkill(targetDir, skillId) !== null,
					),
			});
			continue;
		}
		if (!observation?.enabled || observation.status === "install_failed") continue;
		const prepared = preparedSkills.get(skillId);
		if (!preparedSkillMatchesDesired(prepared, desired, skillId)) {
			throw new Error(`pinned archive for hosted Skill ${skillId} is unavailable`);
		}
		const owner = managedSkillReservationOwner(targetDir, skillId);
		if (existsSync(targetDir) && owner !== "hosted-manifest") {
			throw new Error(`refusing to replace unmanaged ${skillId} skill at ${targetDir}`);
		}
		installReservedManagedSkill(
			{
				targetDir,
				id: skillId,
				manager: "hosted-manifest",
				...preparedReservationIdentity(prepared),
			},
			() => driver.install(prepared, owner === "hosted-manifest"),
		);
	}
}

function runHostedSkillProjectionStep(label: string, step: () => void): void {
	try {
		step();
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}

function reconcileHostedSkillProjection(input: {
	manifest: RuntimeManifest;
	observations: ReadonlyMap<string, RuntimeInstallObservation>;
	home: string;
	openClawWorkspaceRoot: string | null;
	preparedSourcedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>;
	hermesDriver: HostedHermesSkillExactSourceDriver;
	openClawDriver: HostedOpenClawSkillDriver;
}): void {
	const {
		manifest,
		observations,
		home,
		openClawWorkspaceRoot,
		preparedSourcedSkills,
		hermesDriver,
		openClawDriver,
	} = input;
	const preparedSkills = completePreparedHostedSkills(manifest, preparedSourcedSkills);
	const drivers = hostedSkillProjectionDrivers({
		manifest,
		home,
		openClawWorkspaceRoot,
		hermesDriver,
		openClawDriver,
	});
	runHostedSkillProjectionStep("runtime Skill projection planning failed", () => {
		for (const driver of drivers) {
			recoverHostedSkillReservations(driver, manifest, preparedSkills);
			validateHostedSkillsPlan(driver, manifest, preparedSkills);
		}
	});
	for (const driver of drivers) {
		runHostedSkillProjectionStep(`runtime ${driver.name} Skill projection failed`, () => {
			applyHostedSkills(driver, observations.get(driver.name), manifest, preparedSkills);
		});
	}
}

function applyHostedMcpProjections(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
	workspaceRoot: string,
): string[] {
	const plan = buildHostedMcpReconciliationPlan(manifest, paths, observations, workspaceRoot);
	const ledgerPath = hostedMcpLedgerPath(paths);
	const outputs = new Set<string>();
	// Apply Hermes first so both native runtimes converge before the
	// root-owned ownership ledger advances.
	for (const runtime of [...plan.runtimes].sort((left, right) =>
		left.name === right.name ? 0 : left.name === "hermes" ? -1 : 1,
	)) {
		if (runtime.mutations.length === 0) continue;
		if (runtime.name === "hermes") {
			if (!runtime.commandPath || !executableExists(runtime.commandPath)) {
				throw new Error("could not mutate managed Hermes MCP servers: runtime is unavailable");
			}
			const nextServers = { ...runtime.native.servers };
			for (const mutation of runtime.mutations) {
				if (mutation.kind === "remove") delete nextServers[mutation.serverName];
				else nextServers[mutation.serverName] = mutation.server;
			}
			reconcileHermesConfigValue(
				{ command: runtime.commandPath, home: plan.home, cwd: workspaceRoot },
				"mcp_servers",
				Object.keys(nextServers).length > 0 ? nextServers : undefined,
			);
			outputs.add(runtime.commandPath);
			continue;
		}
		if (!runtime.commandPath || !executableExists(runtime.commandPath)) {
			throw new Error("could not mutate managed OpenClaw MCP servers: runtime is unavailable");
		}
		for (const mutation of runtime.mutations) {
			const args =
				mutation.kind === "remove"
					? ["mcp", "unset", mutation.serverName]
					: ["mcp", "set", mutation.serverName, JSON.stringify(mutation.server)];
			runRuntimeUserCommand(runtime.commandPath, args, "", plan.home, workspaceRoot);
		}
		outputs.add(runtime.commandPath);
	}
	// The last-applied ownership map advances only after every native target.
	if (
		Object.keys(plan.nextLedger.runtimes).length > 0 ||
		existsSync(ledgerPath) ||
		existsSync(legacyHostedMcpLedgerPath(paths))
	) {
		writeHostedMcpManagedLedger(paths, plan.nextLedger);
	}
	return [...outputs];
}

type HostedMcpTarget = (typeof HOSTED_RUNTIME_TARGETS)[number];
type HostedMcpNativeServer = ReturnType<typeof hostedMcpNativeServerConfig>;
type HostedMcpMutation =
	| { kind: "remove"; serverName: string }
	| { kind: "set"; serverName: string; server: HostedMcpNativeServer };

interface HostedMcpNativeState {
	servers: Record<string, unknown>;
}

interface HostedMcpRuntimePlan {
	name: HostedMcpTarget;
	native: HostedMcpNativeState;
	mutations: HostedMcpMutation[];
	commandPath: string | null;
}

interface HostedMcpReconciliationPlan {
	home: string;
	runtimes: HostedMcpRuntimePlan[];
	nextLedger: HostedMcpManagedLedger;
}

function buildHostedMcpReconciliationPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
	cwd = hostedRuntimeProjectionHome(manifest, paths),
): HostedMcpReconciliationPlan {
	const intent = hostedMcpIntent(manifest);
	const home = hostedRuntimeProjectionHome(manifest, paths);
	const ledger = readHostedMcpManagedLedger(paths);
	const nextLedger: HostedMcpManagedLedger = {
		schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION,
		runtimes: {},
	};
	const runtimes = HOSTED_RUNTIME_TARGETS.map((name) => {
		const desiredServers = manifest.runtimes[name]?.enabled === true ? intent.servers : {};
		const previousServerNames = new Set(ledger.runtimes[name] ?? []);
		const observation = observations.get(name);
		const commandPath = observation?.commandPath ?? runtimeCommandPath(name, home);
		const needsNativeState = Object.keys(desiredServers).length > 0 || previousServerNames.size > 0;
		if (name === "hermes" && needsNativeState && (!commandPath || !executableExists(commandPath))) {
			throw new Error("could not inspect managed Hermes MCP servers: runtime is unavailable");
		}
		const native = needsNativeState
			? readHostedMcpNativeState(name, home, commandPath, cwd)
			: { servers: {} };
		for (const serverName of Object.keys(desiredServers).sort()) {
			if (previousServerNames.has(serverName)) continue;
			if (Object.hasOwn(native.servers, serverName)) {
				throw new Error(`refusing to replace unmanaged ${name} MCP server ${serverName}`);
			}
		}
		const mutations: HostedMcpMutation[] = [];
		for (const serverName of [...previousServerNames].sort()) {
			if (!Object.hasOwn(desiredServers, serverName) && Object.hasOwn(native.servers, serverName)) {
				// The ledger owns this name even if its native value drifted. Native
				// absence, however, already satisfies deletion and must not invoke an
				// `mcp unset` command that rejects missing names.
				mutations.push({ kind: "remove", serverName });
			}
		}
		for (const [serverName, desired] of Object.entries(desiredServers).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			const server = hostedMcpNativeServerConfig(serverName, desired);
			if (!canonicalJsonEqual(native.servers[serverName], server)) {
				mutations.push({ kind: "set", serverName, server });
			}
		}
		if (Object.keys(desiredServers).length > 0) {
			nextLedger.runtimes[name] = Object.keys(desiredServers).sort();
		}
		const hasSet = mutations.some((mutation) => mutation.kind === "set");
		if (hasSet && (!observation?.enabled || observation.status === "install_failed")) {
			throw new Error(`could not apply managed ${name} MCP servers: runtime is unavailable`);
		}
		return { name, native, mutations, commandPath };
	});
	return { home, runtimes, nextLedger };
}

function readHostedMcpNativeState(
	name: HostedMcpTarget,
	home: string,
	commandPath: string | null,
	cwd: string,
): HostedMcpNativeState {
	if (name === "hermes") {
		if (!commandPath) throw new Error("Hermes config command is unavailable");
		const current = getHermesRawConfigValue({ command: commandPath, home, cwd }, "mcp_servers");
		if (!current.exists) return { servers: {} };
		if (!isPlainRecord(current.value)) {
			throw new Error("Hermes config field mcp_servers must be an object");
		}
		return { servers: current.value };
	}
	const path = join(home, ".openclaw", "openclaw.json");
	if (!existsSync(path)) return { servers: {} };
	const content = readFileSync(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`${name} config is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isPlainRecord(parsed)) throw new Error(`${name} config must be an object`);
	if (parsed.mcpServers !== undefined) {
		throw new Error(
			"openclaw config uses unsupported legacy field mcpServers; canonical MCP state is mcp.servers",
		);
	}
	const mcp = parsed.mcp;
	if (mcp !== undefined && !isPlainRecord(mcp)) {
		throw new Error("openclaw config field mcp must be an object");
	}
	const servers = isPlainRecord(mcp) ? mcp.servers : undefined;
	if (servers === undefined) return { servers: {} };
	if (!isPlainRecord(servers)) {
		throw new Error("openclaw config field mcp.servers must be an object");
	}
	return { servers };
}

function canonicalJsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!isPlainRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [key, canonicalJsonValue(entry)]),
	);
}

function hostedMcpNativeServerConfig(
	serverName: string,
	desired: HostedMcpServerDesiredState,
):
	| { command: string; args: string[] }
	| { url: string; transport: "streamable-http" | "sse"; headers: Record<string, string> } {
	if ("command" in desired) return { command: desired.command, args: [...desired.args] };
	return {
		url: desired.url,
		transport: desired.transport,
		headers: Object.fromEntries(
			Object.entries(desired.headers).map(([name, value]) => [
				name,
				typeof value === "string"
					? value
					: `${value.prefix}${managedMcpHeaderPlaceholder(serverName, name)}`,
			]),
		),
	};
}

function validateHostedMcpProjectionPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
): void {
	buildHostedMcpReconciliationPlan(manifest, paths, observations);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeFileCurrentRevision(path: string): string | null {
	if (!isAbsolute(path)) return null;
	try {
		const linkStat = lstatSync(path);
		if (!linkStat.isFile() && !linkStat.isSymbolicLink()) return null;
		const fileStat = linkStat.isSymbolicLink() ? statSync(path) : linkStat;
		if (!fileStat.isFile()) return null;
		const contents = readFileSync(path);
		return runtimeContentSha256({
			path,
			contentsSha256: createHash("sha256").update(contents).digest("hex"),
			kind: linkStat.isSymbolicLink() ? "symlink" : "file",
			linkTarget: linkStat.isSymbolicLink() ? readlinkSync(path) : null,
			linkUid: linkStat.uid,
			linkGid: linkStat.gid,
			fileMode: fileStat.mode & 0o7777,
			fileUid: fileStat.uid,
			fileGid: fileStat.gid,
		});
	} catch {
		return null;
	}
}

function runtimeCommandCurrentRevision(command: string, home: string, cwd: string): string | null {
	const executableRevision = runtimeFileCurrentRevision(command);
	if (!executableRevision) return null;
	try {
		const versionResult = spawnRuntimeUserCommand(command, ["--version"], home, cwd);
		if (versionResult.status !== 0) return null;
		const stdout = Buffer.isBuffer(versionResult.stdout)
			? versionResult.stdout.toString("utf8")
			: versionResult.stdout;
		const stderr = Buffer.isBuffer(versionResult.stderr)
			? versionResult.stderr.toString("utf8")
			: versionResult.stderr;
		const version = [stdout, stderr].filter(Boolean).join("\n").trim();
		if (!version) return null;
		return runtimeContentSha256({
			executableRevision,
			version,
		});
	} catch {
		return null;
	}
}

function channelPluginDesiredRevision(input: {
	channel: string;
	specs: readonly string[];
}): string {
	return runtimeContentSha256({
		runtime: "openclaw",
		pluginIdentity: input.channel,
		installerCommand: ["plugins", "install", "--force"],
		specs: input.specs,
	});
}

function channelPluginCurrentRevision(input: {
	channel: string;
	specs: readonly string[];
	commandPath: string;
	home: string;
	workspaceRoot: string;
}): string | null {
	const commandRevision = runtimeCommandCurrentRevision(
		input.commandPath,
		input.home,
		input.workspaceRoot,
	);
	if (!commandRevision) return null;
	const inspect = spawnRuntimeUserCommand(
		input.commandPath,
		["plugins", "inspect", input.channel, "--json"],
		input.home,
		input.workspaceRoot,
	);
	if (inspect.status !== 0) return null;
	try {
		const stdout = Buffer.isBuffer(inspect.stdout)
			? inspect.stdout.toString("utf8")
			: inspect.stdout;
		const parsed = openClawPluginInspectSchema.safeParse(JSON.parse(stdout) as unknown);
		if (!parsed.success) return null;
		const { plugin, install } = parsed.data;
		const version = plugin.version ?? install.resolvedVersion ?? install.version;
		const sourceRevision = runtimeFileCurrentRevision(plugin.source);
		if (
			plugin.id !== input.channel ||
			!input.specs.some((spec) => openClawPluginInstallMatchesSpec(install, spec)) ||
			plugin.status !== "loaded" ||
			!plugin.enabled ||
			!version ||
			!sourceRevision
		) {
			return null;
		}
		return runtimeContentSha256({
			commandRevision,
			plugin: {
				id: plugin.id,
				source: plugin.source,
				sourceRevision,
				origin: plugin.origin,
				status: plugin.status,
				version,
				enabled: plugin.enabled === true,
			},
			install: {
				source: install.source,
				spec: install.spec,
				sourcePath: install.sourcePath,
				installPath: install.installPath,
				version: install.version,
				resolvedName: install.resolvedName,
				resolvedVersion: install.resolvedVersion,
				resolvedSpec: install.resolvedSpec,
				integrity: install.integrity,
				shasum: install.shasum,
				npmIntegrity: install.npmIntegrity,
				npmShasum: install.npmShasum,
				clawpackSha256: install.clawpackSha256,
				gitUrl: install.gitUrl,
				gitRef: install.gitRef,
				gitCommit: install.gitCommit,
			},
		});
	} catch {
		return null;
	}
}

function openClawPluginInstallMatchesSpec(
	install: z.infer<typeof openClawPluginInspectSchema>["install"],
	spec: string,
): boolean {
	const recordedSpecs = [install.spec, install.resolvedSpec];
	if (install.source === "clawhub" && install.clawhubPackage) {
		recordedSpecs.push(`clawhub:${install.clawhubPackage}`);
	}
	return recordedSpecs.includes(spec);
}

function verifiedReceiptCurrentRevision(
	receipt: RuntimeInstallReceiptEntry | undefined,
	desiredRevision: string,
	currentRevision: () => string | null,
): string | null {
	if (!receipt || receipt.desiredRevision !== desiredRevision) return null;
	const current = currentRevision();
	return current === receipt.currentRevision ? current : null;
}

function commitRuntimeInstallReceipts(
	targets: RuntimeInstallReceiptTargets,
	paths: RuntimePaths,
): void {
	const receipts = emptyRuntimeInstallReceipts();
	commitRuntimeInstallReceiptGroup(receipts.officialServices, targets.officialServices);
	commitRuntimeInstallReceiptGroup(receipts.channelPlugins, targets.channelPlugins);
	const filebrowser = targets.companions.get("filebrowser");
	if (filebrowser) {
		receipts.companions.filebrowser = verifiedRuntimeInstallReceipt("filebrowser", filebrowser);
	}
	writeRuntimeInstallReceipts(receipts, paths);
}

function verifiedRuntimeInstallReceipt(
	key: string,
	target: RuntimeInstallReceiptTarget,
): RuntimeInstallReceiptEntry {
	if (!target.expectedCurrentRevision) {
		throw new Error(`runtime install receipt target ${key} was not verified`);
	}
	const currentRevision = target.currentRevision();
	if (currentRevision !== target.expectedCurrentRevision) {
		throw new Error(`runtime install receipt target ${key} changed before commit`);
	}
	return { desiredRevision: target.desiredRevision, currentRevision };
}

function commitRuntimeInstallReceiptGroup(
	receipts: Record<string, RuntimeInstallReceiptEntry>,
	targets: Map<string, RuntimeInstallReceiptTarget>,
): void {
	for (const [key, target] of [...targets].sort(([left], [right]) => left.localeCompare(right))) {
		receipts[key] = verifiedRuntimeInstallReceipt(key, target);
	}
}

function clearEgressProfileBundle(paths: RuntimePaths): null {
	rmSync(paths.egressProfileBundle, { force: true });
	return null;
}

function writeEgressEngineStatus(
	result: RuntimeMitmproxyEnsureResult | null,
	paths: RuntimePaths,
): RuntimeMitmproxyEnsureResult | null {
	if (!result) {
		rmSync(paths.egressEngineStatus, { force: true });
		return null;
	}
	writeJsonFile(paths.egressEngineStatus, result, paths);
	return result;
}

function requireV2EgressEngineReady(
	manifest: RuntimeManifest,
	profileBundlePath: string | null,
	engine: RuntimeMitmproxyEnsureResult | null,
): void {
	if (
		manifest.projection?.sourceBundleVersion === HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION &&
		profileBundlePath &&
		engine?.status !== "ready"
	) {
		throw new Error(
			`required egress engine is not ready: ${engine?.error ?? "status unavailable"}`,
		);
	}
}

function writeEgressProfileBundle(bundle: EgressProfileBundle, paths: RuntimePaths): string {
	// Published handoff: the egress sidecar (clawdi-egress uid) reads this
	// bundle, so it lives under the traversable run root next to the other
	// sidecar inputs (addon, transparent env, CA) — never under a private
	// platform root the sidecar cannot traverse.
	writeRuntimePrivateFileAtomic(
		paths,
		paths.egressProfileBundle,
		`${JSON.stringify(bundle, null, 2)}\n`,
		{
			mode: 0o640,
			dirMode: 0o711,
		},
	);
	if (runningAsRoot()) chownSync(paths.egressProfileBundle, 0, runtimeEgressGid());
	return paths.egressProfileBundle;
}

function writeEgressAddon(paths: RuntimePaths): { path: string; sha256: string } {
	const source = resolvePackagedEgressAddon();
	const content = readFileSync(source, "utf-8");
	writeRuntimePrivateFileAtomic(paths, paths.egressAddon, content, {
		mode: 0o640,
		dirMode: 0o711,
	});
	if (runningAsRoot()) chownSync(paths.egressAddon, 0, runtimeEgressGid());
	return { path: paths.egressAddon, sha256: sha256String(content) };
}

function clearEgressAddon(paths: RuntimePaths): null {
	rmSync(paths.egressAddon, { force: true });
	return null;
}

function resolvePackagedEgressAddon(): string {
	const candidate = resolve(
		resolveCurrentCliResourceRoot(),
		"egress-addon",
		"clawdi_egress_addon.py",
	);
	if (existsSync(candidate)) return candidate;
	throw new Error("packaged egress addon is missing");
}

function writeTransparentEgressEnvFile(input: {
	program: RuntimeEgressSystemdProgram | null;
	paths: RuntimePaths;
	runtimeUser: string;
	runtimeUid: number;
	runtimeGid: number;
	egressUid: number;
	egressGid: number;
}): string | null {
	if (!input.program) {
		rmSync(input.paths.egressTransparentEnv, { force: true });
		return null;
	}
	const env: Record<string, string> = {
		CLAWDI_RUNTIME_USER: input.runtimeUser,
		CLAWDI_RUNTIME_UID: String(input.runtimeUid),
		CLAWDI_RUNTIME_GID: String(input.runtimeGid),
		CLAWDI_EGRESS_UID: String(input.egressUid),
		CLAWDI_EGRESS_GID: String(input.egressGid),
		CLAWDI_EGRESS_TRANSPARENT_PORT: String(input.program.transparentPort),
		CLAWDI_EGRESS_NFT_TABLE: TRANSPARENT_EGRESS_TABLE,
		CLAWDI_EGRESS_PROFILE_BUNDLE: input.program.profileBundlePath,
		CLAWDI_EGRESS_SECRET_FILE: input.program.secretFilePath ?? "",
		CLAWDI_EGRESS_CA_DIR: input.paths.egressCaDir,
		CLAWDI_EGRESS_CA_CERT: input.paths.egressCaCert,
		CLAWDI_EGRESS_SYSTEM_CA_BUNDLE: input.program.systemCaBundle,
		CLAWDI_EGRESS_TRANSPORT_VERSION: TRANSPARENT_EGRESS_TRANSPORT_VERSION,
		CLAWDI_EGRESS_ENGINE_TYPE: "mitmproxy",
		CLAWDI_EGRESS_ENGINE_VERSION: input.program.engine.version,
		CLAWDI_EGRESS_ENGINE_URL: input.program.engine.url,
		CLAWDI_EGRESS_ENGINE_SHA256: input.program.engine.sha256,
		CLAWDI_EGRESS_ENGINE_BINARY_PATH: input.paths.egressServiceBinary,
		CLAWDI_EGRESS_ADDON_PATH: input.program.addonPath,
		CLAWDI_EGRESS_ADDON_SHA256: input.program.addonSha256,
	};
	const lines = Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${runtimeEnvironmentFileQuote(value)}`);
	writeRuntimePrivateFileAtomic(
		input.paths,
		input.paths.egressTransparentEnv,
		`${lines.join("\n")}\n`,
		{
			mode: 0o640,
			dirMode: 0o711,
		},
	);
	if (runningAsRoot()) chownSync(input.paths.egressTransparentEnv, 0, input.egressGid);
	return input.paths.egressTransparentEnv;
}

function runtimeEnvironmentFileQuote(value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new Error("runtime environment files only support single-line values");
	}
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sha256String(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function removeStaleRuntimeRunConfigs(writtenRunConfigIds: Set<string>, paths: RuntimePaths): void {
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

const MANAGED_LIVE_SYNC_AGENTS = ["openclaw", "hermes", "codex"] as const;
const OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS: Record<string, readonly string[]> = {
	discord: ["@openclaw/discord"],
	whatsapp: ["clawhub:@openclaw/whatsapp"],
};

const OPENCLAW_MANAGED_CHANNELS = ["telegram", "discord", "whatsapp"] as const;

function desiredLiveSyncAgents(manifest: RuntimeManifest): LiveSyncAgent[] {
	if (manifest.liveSync?.enabled === false) return [];
	const agents = manifest.liveSync?.agents ?? [];
	const byAgent = new Map<LiveSyncAgent["agentType"], LiveSyncAgent>();
	for (const agent of agents) byAgent.set(agent.agentType, agent);
	return [...byAgent.values()].sort((a, b) => a.agentType.localeCompare(b.agentType));
}

function writeLiveSyncEnvironmentFiles(manifest: RuntimeManifest, paths: RuntimePaths): string[] {
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
function removeLegacyTenantClawdiState(paths: RuntimePaths): void {
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

function writeDaemonAuthToken(
	paths: RuntimePaths,
	secretValues: Record<string, string> | undefined,
): string | null {
	const path = ensureRuntimeAuthTokenFile(paths, secretValues ?? {});
	if (!path) return null;
	makeManagedSecretRoot(dirname(path));
	return path;
}

function daemonAuthTokenRevision(token: string): string {
	return runtimeContentSha256({
		schemaVersion: "clawdi.daemonAuthTokenRevision.v1",
		token,
	});
}

function runtimeProgramRevisionForManifest(
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

function runtimeWorkspaceRoot(manifest: RuntimeManifest, paths: RuntimePaths): string {
	return manifest.workspaceRoot ?? paths.workspaceRoot;
}

function runtimeSecretValues(load: RuntimeManifestLoad): Record<string, string> | undefined {
	return load.secretValues && Object.keys(load.secretValues).length > 0
		? load.secretValues
		: undefined;
}

function planRuntimeSystemdUserPrograms(input: {
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

function withHermesDashboardAuthEnvironment(
	manifest: RuntimeManifest,
	settings: RuntimeRunSettings | undefined,
): RuntimeRunSettings | undefined {
	const auth = manifest.hermesDashboardAuth;
	if (!auth) return settings;
	if (!auth.activation.enabled) {
		throw new Error("Hermes password authentication is disabled");
	}
	return {
		...(settings ?? {}),
		prependPath: settings?.prependPath ?? [],
		env: settings?.env ?? {},
		secretEnv: {
			...(settings?.secretEnv ?? {}),
			HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: auth.passwordSecretRef,
			HERMES_DASHBOARD_BASIC_AUTH_SECRET: auth.sessionSecretRef,
		},
	};
}

interface ResolvedRuntimeRunConfigs {
	runtime: RuntimeRunConfig;
	services: RuntimeRunConfig[];
	secretEnv: Record<string, string>;
	secretFilePath: string | null;
}

function resolveRuntimeRunConfigs(input: {
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

function runtimeConvergenceWithoutApply(input: {
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

function validateRuntimeProjectionPlan(input: {
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

export function runtimeInstallerMutationTargets(
	manifest: RuntimeManifest,
	home: string,
	observations: ReadonlyMap<string, Pick<RuntimeInstallObservation, "status">>,
): string[] {
	const targets = new Set<string>();
	const openclawObservation = observations.get("openclaw");
	if (
		manifest.runtimes.openclaw?.enabled &&
		manifest.runtimes.openclaw.install &&
		openclawObservation?.status !== "present"
	) {
		targets.add(join(home, ".local", "bin", "openclaw"));
		targets.add(join(home, ".local", "tools"));
	}
	const hermesObservation = observations.get("hermes");
	if (
		manifest.runtimes.hermes?.enabled &&
		manifest.runtimes.hermes.install &&
		hermesObservation?.status !== "present"
	) {
		for (const target of [
			join(home, ".hermes", "hermes-agent"),
			join(home, ".hermes", "bin"),
			join(home, ".hermes", "node"),
			join(home, ".hermes", "uv"),
			join(home, ".hermes", ".env"),
			join(home, ".hermes", ".no-bundled-skills"),
			join(home, ".hermes", "config.yaml"),
			join(home, ".hermes", "SOUL.md"),
			join(home, ".hermes", "skills"),
			join(home, ".local", "bin", "hermes"),
			join(home, ".local", "bin", "hermes-agent"),
			join(home, ".local", "bin", "hermes-acp"),
			join(home, ".local", "bin", "node"),
			join(home, ".local", "bin", "npm"),
			join(home, ".local", "bin", "npx"),
		]) {
			targets.add(target);
		}
	}
	return [...targets];
}

const HERMES_INSTALLER_DATA_DIRECTORIES = [
	"cron",
	"sessions",
	"logs",
	"pairing",
	"hooks",
	"image_cache",
	"audio_cache",
	"memories",
] as const;

function runtimeColdInstallMutationPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
): {
	snapshot: RuntimeManagedMutationPlan;
	runtimeUserOwnership: RuntimeUserOwnershipRule[];
} | null {
	const pending = Object.entries(manifest.runtimes).some(([name, runtime]) => {
		if (!runtime.enabled || !runtime.install) return false;
		return observations.get(name)?.status !== "present";
	});
	if (!pending) return null;
	const home = hostedRuntimeProjectionHome(manifest, paths);
	const runtimeUserTargets = runtimeInstallerMutationTargets(manifest, home, observations).sort();
	if (runtimeUserTargets.length === 0) return null;
	const runtimeUserTrustedRoots = [paths.userHome, paths.clawdiHome];
	const metadataTargets = [
		...new Set([
			paths.userHome,
			paths.clawdiHome,
			...mutationAncestorMetadataTargets(runtimeUserTargets, runtimeUserTrustedRoots),
			...(manifest.runtimes.hermes?.enabled &&
			manifest.runtimes.hermes.install &&
			observations.get("hermes")?.status !== "present"
				? HERMES_INSTALLER_DATA_DIRECTORIES.map((directory) => join(home, ".hermes", directory))
				: []),
		]),
	].sort();
	const runtimeCommandTargets = Object.keys(manifest.runtimes).flatMap((name) => {
		const command = runtimeCommandPath(name, home);
		return command && runtimeUserTargets.includes(command) ? [command] : [];
	});
	return {
		snapshot: {
			rootTargets: [],
			trustedRootDirectories: [],
			runtimeUserTargets,
			runtimeUserTrustedRoots,
			runtimeUserSymlinkTargets: runtimeCommandTargets,
			metadataTargets,
		},
		runtimeUserOwnership: runtimeUserExistingOwnership([...metadataTargets, ...runtimeUserTargets]),
	};
}

function excludeRuntimeSnapshotCoverage(
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

function managedOpenClawPluginBootstrapMutationPlan(
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

class RuntimeSnapshotRollbackStack {
	readonly #snapshots: Array<{ failure: string; snapshot: RuntimeLiveSnapshot }> = [];

	capture(failure: string, plan: RuntimeManagedMutationPlan): RuntimeLiveSnapshot {
		const snapshot = captureRuntimeLiveSnapshot(plan);
		this.#snapshots.push({ failure, snapshot });
		return snapshot;
	}

	restore(): string[] {
		const errors: string[] = [];
		for (const { failure, snapshot } of this.#snapshots.splice(0).reverse()) {
			try {
				restoreRuntimeLiveSnapshot(snapshot);
			} catch (error) {
				errors.push(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
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

function managedWhatsAppCompatibilityRuntime(
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

function hostedSkillMutationTargets(
	manifest: RuntimeManifest,
	home: string,
	openClawWorkspaceRoot: string | null,
): string[] {
	const targets = new Set<string>();
	const hermesSkillsRoot = join(home, ".hermes", "skills");
	const openClawSkillsRoot = openClawWorkspaceRoot ? join(openClawWorkspaceRoot, "skills") : null;
	let managesHermesSourcedSkill = false;
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		targets.add(join(hermesSkillsRoot, skillId));
		if (openClawSkillsRoot) targets.add(join(openClawSkillsRoot, skillId));
		if ("source" in desired && manifest.runtimes.hermes?.enabled === true) {
			managesHermesSourcedSkill = true;
		}
	}
	for (const skillId of hostedBundledSkillIds()) {
		targets.add(join(hermesSkillsRoot, skillId));
		if (openClawSkillsRoot) targets.add(join(openClawSkillsRoot, skillId));
	}
	for (const reservation of managedSkillReservations("hosted-manifest")) {
		if (dirname(reservation.targetDir) === hermesSkillsRoot) {
			if (reservation.sourceIdentity) managesHermesSourcedSkill = true;
			targets.add(reservation.targetDir);
		}
		if (openClawSkillsRoot && dirname(reservation.targetDir) === openClawSkillsRoot) {
			targets.add(reservation.targetDir);
		}
	}
	if (managesHermesSourcedSkill) targets.add(join(hermesSkillsRoot, ".hub"));
	return [...targets].sort();
}

function mutationAncestorMetadataTargets(
	targets: readonly string[],
	boundaries: readonly string[],
): string[] {
	const resolvedBoundaries = boundaries.map((boundary) => resolve(boundary));
	const metadata = new Set<string>();
	for (const target of targets) {
		const resolvedTarget = resolve(target);
		const resolvedBoundary = resolvedBoundaries.find((boundary) => {
			const relativeTarget = relative(boundary, resolvedTarget);
			return (
				relativeTarget === "" || (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget))
			);
		});
		if (!resolvedBoundary) {
			throw new Error(`runtime mutation target is outside managed user roots: ${resolvedTarget}`);
		}
		if (resolvedTarget === resolvedBoundary) continue;
		let parent = dirname(resolvedTarget);
		while (parent !== resolvedBoundary) {
			metadata.add(parent);
			parent = dirname(parent);
		}
	}
	return [...metadata];
}

function runtimeManagedMutationPlan(input: {
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
	const runtimeUserOwnership = runtimeUserExistingOwnership([
		...runtimeUserTargets,
		...runtimeUserMetadataTargets,
		...runtimeCommandTargets,
	]);
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

export function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: {
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
	} = {},
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
	const openClawContext = createOpenClawHostedContext(manifest, projectionHome);
	// Runtime-user state ownership is a platform invariant, not a manifest
	// mutation: repair it before snapshots so rollback cannot restore drift.
	enforceRuntimeUserOwnership(openClawContext.ownership);
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
	const workspaceExistedBeforeApply = existsSync(workspaceRoot);
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
				);
				skillProjectionSnapshot = captureRuntimeLiveSnapshot({
					rootTargets: [managedSkillReservationLedgerPath()],
					trustedRootDirectories: [paths.managedResourceRoot],
					runtimeUserTargets: skillMutationTargets,
					runtimeUserTrustedRoots: [paths.userHome, paths.clawdiHome],
					runtimeUserSymlinkTargets: [],
					metadataTargets: mutationAncestorMetadataTargets(skillMutationTargets, [
						paths.userHome,
						paths.clawdiHome,
					]),
				});
				reconcileHostedSkillProjection({
					manifest,
					observations,
					home: projectionHome,
					openClawWorkspaceRoot,
					preparedSourcedSkills: preparedHostedSourcedSkills,
					hermesDriver: hermesSkillNativeReconciler,
					openClawDriver: openClawSkillDriver,
				});
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
					command: runtimeInstallerCommand(name, runtime.install),
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
			existsSync(workspaceRoot)
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
