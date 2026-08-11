import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lchownSync,
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
import type { AiProviderCatalog } from "@clawdi/shared";
import {
	CLAWDI_MANAGED_PROVIDER_ID,
	CLAWDI_MANAGED_V1_PROVIDER_ID,
	isClawdiManagedV2ProviderId,
} from "@clawdi/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { agentSkillTargetDir } from "../adapters/registry";
import { type AgentPrimaryModel, buildAgentTargetProjection } from "../lib/ai-provider-projection";
import {
	decideChatGptOAuthCredentialReconciliation,
	intentLedgerForDecision,
	type NativeOAuthCredentialObservation,
	type OAuthCredentialLedgerSnapshot,
} from "../lib/chatgpt-oauth-reconciliation";
import {
	HERMES_CODEX_AUTH_HELPER,
	type HermesCodexAuthAction,
	type NativeOAuthCredentialMutationResult,
	nativeOAuthMutationResult,
	nativeOAuthObservation,
	nativeOAuthProfileId,
	type OAuthCredentialOwnership,
	OPENCLAW_PROVIDER_AUTH_HELPER,
	type OpenClawProviderAuthAction,
	oauthCredentialFingerprint,
	resolveOpenClawProviderAuthSdkExport,
} from "../lib/codex-oauth-native-store";
import { resolveCurrentCliResourceRoot } from "../lib/current-cli-invocation";
import {
	mergeHermesChannelConfig,
	mergeHermesConfig,
	mergeHermesDashboardBasicAuth,
	mergeHermesRuntimeLocale,
	renderHermesChannelConfig,
	renderHermesConfig,
	renderHermesMcpServer,
	renderHermesMcpServerRemoval,
	renderHermesRuntimeLocale,
} from "../lib/hermes-config-merge";
import {
	type OAuthCredentialLedger,
	oauthCredentialLedgerPath,
	oauthCredentialLedgerSnapshot,
	readOAuthCredentialLedger,
	writeOAuthCredentialLedger,
} from "../lib/oauth-credential-ledger";
import { writePrivateFileAtomic } from "../lib/private-file";
import { readRuntimeAppliedState, runtimeContentSha256 } from "./applied-state";
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
	adoptableLegacyHostedBundledSkill,
	assertHostedBundledSkillCatalogDigest,
	hostedBundledSkillIds,
	loadHostedBundledSkill,
	reconcileHostedBundledSkill,
	resolveHostedBundledSkill,
	withStagedHostedBundledSkill,
} from "./hosted-bundled-skill";
import { managedMcpHeaderPlaceholder, normalizeSecretRef } from "./hosted-egress-profiles";
import {
	type HostedHermesSkillExactSourceDriver,
	hostedHermesSkillExactSourceDriver,
} from "./hosted-hermes-skill";
import { type HostedOpenClawSkillDriver, hostedOpenClawSkillDriver } from "./hosted-openclaw-skill";
import {
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
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
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
	installReservedManagedSkill,
	managedSkillReservationOwner,
	managedSkillReservations,
	releaseManagedSkill,
	reserveManagedSkill,
} from "./managed-skill-reservation";
import type { LiveSyncAgent, RuntimeInstall, RuntimeManifest } from "./manifest-contract";
import {
	type HostedMcpServerDesiredState,
	type HostedSkillSource,
	hostedMcpDesiredStateSchema,
} from "./manifest-resources";
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
import { runtimeImpactRevision, runtimeProgramRevision } from "./runtime-impact-revision";
import {
	buildRuntimeSystemdUserProgram,
	installOfficialRuntimeService,
	planHermesDashboardArtifact,
	planOfficialRuntimeServices,
	planRuntimeSystemdUserMutations,
	prepareHermesDashboardArtifact,
	type RuntimeEgressSystemdProgram,
	type RuntimeSystemdStaleFilePlan,
	type RuntimeSystemdUserProgram,
	removeStaleRuntimeSystemdFiles,
	resolveRuntimeSystemdIdentity,
	runtimeSystemdCommonEnvironment,
	uninstallStaleOfficialRuntimeServices,
	validateRuntimeSystemdPlan,
	writeRuntimeSystemdState,
} from "./runtime-systemd-reconciliation";
import {
	buildRuntimeUserCommand,
	clearTenantToolLocationOverrides,
	commandExists,
	commandResolvable,
	executableExists,
	makeRuntimeUserOwned,
	runningAsRoot,
	runRuntimeUserCommand,
	runtimeEgressGid,
	runtimeEgressUid,
	runtimeUserGid,
	runtimeUserUid,
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
	projectedProviderIds: Record<string, string[]>;
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
		instanceSemaphores: string[];
		bootFinished: string;
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
	staleSystemUnits: string[];
	staleUserUnits: string[];
}

interface RuntimeSystemdApplyHooks {
	activateEgressPrerequisite: (signal: RuntimeSystemdApplySignal) => RuntimeSystemdApplyResult;
	activate: (signal: RuntimeSystemdApplySignal) => RuntimeSystemdApplyResult;
	quiesce: () => void;
	rollback: (signal: RuntimeSystemdApplySignal) => void;
}

export interface RuntimePrivateAppliedAuthority {
	// These are secret-dependent verifiers and may only be persisted in the
	// root-owned 0600 applied-state authority.
	daemonAuthTokenRevision?: string;
	egressSidecarSecretRevision?: string;
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

// Supported by `openclaw plugins inspect <id> --json`. The command returns
// `{ ...inspect, install }` from the cold registry and persisted install index:
// https://github.com/openclaw/openclaw/blob/main/src/cli/plugins-inspect-command.ts
// Keep this as a passthrough boundary because OpenClaw exposes additional
// diagnostics; the receipt only depends on documented registry/install identity.
const openClawPluginInspectSchema = z
	.object({
		plugin: z
			.object({
				id: z.string().min(1),
				source: z.string().min(1),
				origin: z.enum(["bundled", "global", "workspace", "config"]),
				status: z.enum(["loaded", "disabled", "error"]),
				version: z.string().min(1).optional(),
				enabled: z.boolean(),
			})
			.passthrough(),
		install: z
			.object({
				source: z.enum(["npm", "archive", "path", "clawhub", "git"]),
				spec: z.string().min(1).optional(),
				sourcePath: z.string().min(1).optional(),
				installPath: z.string().min(1).optional(),
				version: z.string().min(1).optional(),
				resolvedName: z.string().min(1).optional(),
				resolvedVersion: z.string().min(1).optional(),
				resolvedSpec: z.string().min(1).optional(),
				integrity: z.string().min(1).optional(),
				shasum: z.string().min(1).optional(),
				npmIntegrity: z.string().min(1).optional(),
				npmShasum: z.string().min(1).optional(),
				clawpackSha256: z.string().min(1).optional(),
				gitUrl: z.string().min(1).optional(),
				gitRef: z.string().min(1).optional(),
				gitCommit: z.string().min(1).optional(),
			})
			.passthrough(),
	})
	.passthrough();

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

interface ManagedWhatsAppAuthCredential {
	accountKey: string;
	credentialId: string;
	authDir: string;
	credsJsonSecretRef: string;
	target: "openclaw" | "hermes" | "legacy";
}

const MANAGED_WHATSAPP_AUTH_MARKER = ".clawdi-managed-whatsapp-auth.json";

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
	const raw = manifest.projection?.channelCredentials;
	if (!Array.isArray(raw)) return [];
	return raw
		.flatMap(parseManagedWhatsAppAuthCredentials)
		.filter((entry): entry is ManagedWhatsAppAuthCredential => entry !== null)
		.sort((left, right) =>
			`${left.target}:${left.accountKey}:${left.credentialId}`.localeCompare(
				`${right.target}:${right.accountKey}:${right.credentialId}`,
			),
		);
}

function parseManagedWhatsAppAuthCredentials(value: unknown): ManagedWhatsAppAuthCredential[] {
	const record = recordValue(value);
	if (!record) return [];
	if (record.provider !== "whatsapp" || record.kind !== "whatsapp_baileys_auth_state") return [];
	const accountKey = stringValue(record.accountKey);
	const credentialId = stringValue(record.credentialId);
	const files = Array.isArray(record.files) ? record.files : [];
	const credsFile = files
		.map(recordValue)
		.find((file) => file?.path === "creds.json" && typeof file.secretRef === "string");
	const credsJsonSecretRef = credsFile ? stringValue(credsFile.secretRef) : null;
	if (!accountKey || !credentialId || !credsJsonSecretRef) {
		throw new Error("WhatsApp auth credential projection is incomplete");
	}
	const targets = recordValue(record.targets);
	const parsedTargets: ManagedWhatsAppAuthCredential[] = [];
	const openclawTarget = targets ? recordValue(targets.openclaw) : null;
	const openclawAuthDir = targets
		? stringValue(openclawTarget?.authDir)
		: stringValue(record.authDir);
	if (openclawAuthDir) {
		parsedTargets.push({
			accountKey,
			credentialId,
			authDir: openclawAuthDir,
			credsJsonSecretRef,
			target: targets ? "openclaw" : "legacy",
		});
	}
	const hermesTarget = targets ? recordValue(targets.hermes) : null;
	const hermesAuthDir = hermesTarget ? stringValue(hermesTarget.authDir) : null;
	if (hermesAuthDir) {
		parsedTargets.push({
			accountKey,
			credentialId,
			authDir: hermesAuthDir,
			credsJsonSecretRef,
			target: "hermes",
		});
	}
	if (parsedTargets.length === 0) {
		throw new Error("WhatsApp auth credential projection is incomplete");
	}
	return parsedTargets;
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

	makeRuntimeUserPrivateDir(credential.authDir, home);
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

function readManagedWhatsAppAuthMarker(authDir: string): { credentialId: string } | null {
	const markerPath = join(authDir, MANAGED_WHATSAPP_AUTH_MARKER);
	try {
		if (!lstatSync(markerPath).isFile()) return null;
		const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as unknown;
		const record = recordValue(parsed);
		const credentialId = record ? stringValue(record.credentialId) : null;
		return credentialId ? { credentialId } : null;
	} catch {
		return null;
	}
}

function removeManagedWhatsAppAuthDir(authDir: string): void {
	if (!readManagedWhatsAppAuthMarker(authDir)) return;
	rmSync(authDir, { recursive: true, force: true });
}

function removeStaleManagedWhatsAppAuthDirs(home: string, expected: Set<string>): void {
	const openclawRoot = managedWhatsAppAuthRoot(home, "openclaw");
	if (openclawRoot && existsSync(openclawRoot)) {
		removeStaleManagedWhatsAppAuthDirsUnderRoot(openclawRoot, expected);
	}
	const hermesAuthDir = managedWhatsAppAuthRoot(home, "hermes");
	if (hermesAuthDir && !expected.has(hermesAuthDir)) {
		removeManagedWhatsAppAuthDir(hermesAuthDir);
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

function makeRuntimeUserPrivateDir(path: string, home: string): void {
	mkdirSync(path, { recursive: true });
	makeRuntimeUserOwnedAncestors(path, home);
	makeRuntimeUserOwned(path);
	try {
		chmodSync(path, 0o700);
	} catch {
		// Best effort for non-POSIX local development environments.
	}
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

function ensureRuntimeUserHome(path: string): void {
	mkdirSync(path, { recursive: true });
	const node = lstatSync(path);
	if (node.isSymbolicLink() || !node.isDirectory()) {
		throw new Error(`runtime user home must be a real directory: ${path}`);
	}
	makeRuntimeUserOwned(path);
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

function makeRuntimeUserOwnedAncestors(path: string, home: string): void {
	const resolvedHome = resolve(home);
	let current = resolve(dirname(path));
	while (current === resolvedHome || current.startsWith(`${resolvedHome}/`)) {
		makeRuntimeUserOwned(current);
		if (current === resolvedHome) return;
		current = dirname(current);
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

const liveSyncEnvironmentIndexSchema = z
	.object({
		schemaVersion: z.literal("clawdi.liveSyncEnvironments.v1"),
		agentTypes: z.array(runtimeNameSchema).default([]),
	})
	.strict();

function runtimeInstallerExecution(
	install: RuntimeInstall,
	installerPath: string,
): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	executionUser: string | null;
} {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	const env = runtimeInstallerEnv(install);
	if (!runtimeUser || runtimeUser === "root") {
		return {
			command: "bash",
			args: [installerPath, ...install.args],
			env,
			executionUser: null,
		};
	}

	const child = buildRuntimeUserCommand(runtimeUser, install.home, "bash", [
		installerPath,
		...install.args,
	]);
	return {
		command: child.command,
		args: child.args,
		env: { ...env, ...child.env },
		executionUser: runtimeUser,
	};
}

function runtimeInstallerEnv(install: RuntimeInstall): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: install.home,
		PATH: [join(install.home, ".local", "bin"), process.env.PATH].filter(Boolean).join(":"),
	};
	clearTenantToolLocationOverrides(env);
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

function runOfficialInstaller(
	name: string,
	install: RuntimeInstall,
	options: { force?: boolean } = {},
): RuntimeInstallObservation {
	const installStartedAt = new Date().toISOString();
	const installStartedMs = Date.now();
	const finish = (
		observation: Omit<
			RuntimeInstallObservation,
			"installStartedAt" | "installFinishedAt" | "installDurationMs"
		>,
	): RuntimeInstallObservation => ({
		...observation,
		installStartedAt,
		installFinishedAt: new Date().toISOString(),
		installDurationMs: Math.max(0, Date.now() - installStartedMs),
	});
	const commandPath = runtimeCommandPath(name, install.home);
	const appRoot = runtimeAppRoot(name, install.home);
	if (!commandPath || !appRoot) {
		return finish({
			runtime: name,
			enabled: true,
			status: "install_failed",
			executionUser: null,
			commandPath,
			appRoot,
			install,
			installerUrl: install.url,
			executedInstallerUrl: null,
			exitCode: null,
			stdoutTail: null,
			stderrTail: null,
			error: `unsupported runtime ${name}`,
		});
	}
	if (executableExists(commandPath) && !options.force) {
		return finish({
			runtime: name,
			enabled: true,
			status: "present",
			executionUser: null,
			commandPath,
			appRoot,
			install,
			installerUrl: install.url,
			executedInstallerUrl: null,
			exitCode: null,
			stdoutTail: null,
			stderrTail: null,
			error: null,
		});
	}

	ensureRuntimeUserHome(install.home);
	const url = executionInstallerUrl(name, install.url);
	const materialized = materializeInstaller(name, url);
	try {
		const execution = runtimeInstallerExecution(install, materialized.path);
		const result = spawnSync(execution.command, execution.args, {
			cwd: install.home,
			env: execution.env,
			encoding: "utf8",
			timeout: Number.parseInt(process.env.CLAWDI_RUNTIME_INSTALL_TIMEOUT ?? "1800000", 10),
		});
		const exitCode = result.status ?? 1;
		const installed = exitCode === 0 && executableExists(commandPath);
		return finish({
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
		});
	} catch (error) {
		return finish({
			runtime: name,
			enabled: true,
			status: "install_failed",
			executionUser: null,
			commandPath,
			appRoot,
			install,
			installerUrl: install.url,
			executedInstallerUrl: url,
			exitCode: null,
			stdoutTail: null,
			stderrTail: null,
			error: error instanceof Error ? error.message : String(error),
		});
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
		return {
			runtime: name,
			enabled: false,
			status: "disabled",
			executionUser: null,
			commandPath: null,
			appRoot: null,
			install: runtime.install ?? null,
			installerUrl: runtime.install?.url ?? null,
			executedInstallerUrl: null,
			exitCode: null,
			stdoutTail: null,
			stderrTail: null,
			error: null,
		} satisfies RuntimeInstallObservation;
	}
	if (!runtime.install) {
		if (runtime.run?.command?.trim() || isSupportedRuntimeName(name)) {
			const configuredCommand = runtime.run?.command?.trim() || null;
			const commandPath =
				isSupportedRuntimeName(name) && configuredCommand && commandResolvable(configuredCommand)
					? configuredCommand
					: null;
			return {
				runtime: name,
				enabled: true,
				status: "configured",
				executionUser: null,
				commandPath,
				appRoot: commandPath ? runtimeAppRoot(name, home) : null,
				install: null,
				installerUrl: null,
				executedInstallerUrl: null,
				exitCode: null,
				stdoutTail: null,
				stderrTail: null,
				error: null,
			} satisfies RuntimeInstallObservation;
		}
		return {
			runtime: name,
			enabled: true,
			status: "install_failed",
			executionUser: null,
			commandPath: null,
			appRoot: null,
			install: null,
			installerUrl: null,
			executedInstallerUrl: null,
			exitCode: null,
			stdoutTail: null,
			stderrTail: null,
			error: `runtime ${name} is enabled but missing install metadata`,
		} satisfies RuntimeInstallObservation;
	}
	return runOfficialInstaller(name, runtime.install);
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
	return {
		runtime: name,
		enabled: true,
		status: commandPath && executableExists(commandPath) ? "present" : "configured",
		executionUser: null,
		commandPath,
		appRoot,
		install: runtime.install,
		installerUrl: runtime.install.url,
		executedInstallerUrl: null,
		exitCode: null,
		stdoutTail: null,
		stderrTail: null,
		error: commandPath && appRoot ? null : `unsupported runtime ${name}`,
	};
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
	const { existing, next } = nextManagedLocaleFileContent(path, block);
	if (next === existing) return path;
	writePrivateFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 });
	makeRuntimeUserOwned(path);
	return path;
}

function applyHostedLocaleProjection(
	runtime: string,
	manifest: RuntimeManifest,
	home: string,
	openClawWorkspaceRoot: string | null,
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
		if (!auth && !locale) return null;
		const hermesHome = join(home, ".hermes");
		makeRuntimeUserPrivateDir(hermesHome, home);
		const configPath = join(hermesHome, "config.yaml");
		if (auth) {
			mergeHermesDashboardBasicAuth(configPath, auth.username, auth.sessionTtlSeconds);
		}
		if (locale) mergeHermesRuntimeLocale(configPath, locale.timezone);
		makeRuntimeUserOwned(configPath);
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
	return mergeRuntimeServiceEnvWithProviderPlaceholders(
		runtime,
		service,
		hermesDashboardServiceSettings(manifest, runtime, service, settings),
		providerEnv,
	);
}

function mergeRuntimeSecretEnv(
	runtimeName: string,
	runtime: RuntimeManifest["runtimes"][string],
	providerSecretEnv: Record<string, string>,
): Record<string, string> {
	const merged = { ...providerSecretEnv };
	const runtimeSecretEnv = runtime.run?.secretEnv ?? {};
	for (const [envName, ref] of Object.entries(runtimeSecretEnv)) {
		const existing = merged[envName];
		if (existing !== undefined && existing !== ref) {
			throw new Error(
				`runtime ${runtimeName} secretEnv.${envName} conflicts with provider secret ref ${existing}`,
			);
		}
		merged[envName] = ref;
	}
	for (const envName of Object.keys(runtime.run?.env ?? {})) {
		if (merged[envName] !== undefined) {
			throw new Error(`runtime ${runtimeName} defines ${envName} in both env and secretEnv`);
		}
	}
	return merged;
}

function mergeRuntimeServiceSecretEnv(
	runtimeName: string,
	serviceName: string,
	serviceSettings: NonNullable<RuntimeManifest["runtimes"][string]["services"]>[string],
	providerSecretEnv: Record<string, string>,
): Record<string, string> {
	const merged = { ...providerSecretEnv };
	const serviceSecretEnv = serviceSettings.secretEnv ?? {};
	for (const [envName, ref] of Object.entries(serviceSecretEnv)) {
		const existing = merged[envName];
		if (existing !== undefined && existing !== ref) {
			throw new Error(
				`runtime ${runtimeName} service ${serviceName} secretEnv.${envName} conflicts with provider secret ref ${existing}`,
			);
		}
		merged[envName] = ref;
	}
	for (const envName of Object.keys(serviceSettings.env ?? {})) {
		if (merged[envName] !== undefined) {
			throw new Error(
				`runtime ${runtimeName} service ${serviceName} defines ${envName} in both env and secretEnv`,
			);
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
const CODEX_MANAGED_ENV_KEY = "OPENAI_API_KEY";
const CODEX_NPM_PACKAGE_VERSION = "0.146.0";
const CODEX_NPM_PACKAGE_SPEC = `@openai/codex@${CODEX_NPM_PACKAGE_VERSION}`;

interface HostedCodexManagedProvider {
	baseUrl: string;
	model: string;
}

export type HostedAiProviderProjectionInput = {
	catalog: AiProviderCatalog;
	primaryModel: AgentPrimaryModel;
};

function agentTargetProjectionInput(
	input: HostedAiProviderProjectionInput | null,
): HostedAiProviderProjectionInput | null {
	if (!input) return null;
	const providerIdMap = new Map<string, string>();
	const providers = input.catalog.providers.map((provider) => {
		if (provider.managed_by !== "clawdi") return provider;
		const id = isClawdiManagedV2ProviderId(provider.id)
			? CLAWDI_MANAGED_PROVIDER_ID
			: provider.id === CLAWDI_MANAGED_V1_PROVIDER_ID || provider.id.startsWith("clawdi-managed")
				? provider.id
				: CLAWDI_MANAGED_V1_PROVIDER_ID;
		providerIdMap.set(provider.id, id);
		return {
			...provider,
			id,
			api_mode: isClawdiManagedV2ProviderId(id) ? "openai_chat" : "openai_responses",
		} satisfies AiProviderCatalog["providers"][number];
	});
	const primaryProviderId = providerIdMap.get(input.primaryModel.provider_id);
	if (!primaryProviderId) return input;
	return {
		catalog: {
			...input.catalog,
			providers,
			defaults: { ...input.catalog.defaults, chat_provider_id: primaryProviderId },
		},
		primaryModel: { ...input.primaryModel, provider_id: primaryProviderId },
	};
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

function hostedRuntimeOAuthDeclared(
	manifest: RuntimeManifest,
	runtime: "hermes" | "openclaw",
): boolean {
	if (manifest.runtimes[runtime]?.enabled !== true) return false;
	const providers = recordValue(manifest.projection?.providers);
	if (!providers) return false;
	return (manifest.runtimes[runtime]?.provider_ids ?? []).some((providerId) => {
		const auth = recordValue(recordValue(providers[providerId])?.auth);
		return (
			auth?.type === "agent_profile" &&
			auth.tool === "codex" &&
			typeof auth.credentialSecretRef === "string" &&
			typeof auth.credentialRevision === "string"
		);
	});
}

function hermesAuthPath(home: string): string {
	return join(home, ".hermes", "auth.json");
}

function runHermesCodexAuthCommand(
	home: string,
	workspaceRoot: string,
	action: HermesCodexAuthAction,
	profileId: string,
	credentialRevision: string,
	material?: RuntimeOAuthMaterial,
	ownership?: OAuthCredentialOwnership,
	expectedFingerprint?: string,
): Record<string, unknown> {
	const authPath = hermesAuthPath(home);
	makeRuntimeUserPrivateDir(dirname(authPath), home);
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
			action,
			profileId,
			ownership?.nativeProfileId ?? "",
			credentialRevision,
			expectedFingerprint ?? "",
		],
		home,
		workspaceRoot,
		{ input: material ? JSON.stringify(material) : "null" },
	);
	if (result.status !== 0) {
		throw new Error(
			`Hermes Codex auth ${action} failed: ${tail(String(result.stderr ?? "")) ?? "unknown"}`,
		);
	}
	const output = recordValue(JSON.parse(String(result.stdout || "{}")) as unknown);
	return output ?? {};
}

function observeHermesCodexAuth(
	home: string,
	workspaceRoot: string,
	profileId: string,
	credentialRevision: string,
	ownership?: OAuthCredentialOwnership,
): NativeOAuthCredentialObservation {
	return nativeOAuthObservation(
		runHermesCodexAuthCommand(
			home,
			workspaceRoot,
			"inspect",
			profileId,
			credentialRevision,
			undefined,
			ownership,
		),
	);
}

function runHermesCodexAuth(
	home: string,
	workspaceRoot: string,
	action: Exclude<HermesCodexAuthAction, "inspect">,
	profileId: string,
	credentialRevision: string,
	material?: RuntimeOAuthMaterial,
	ownership?: OAuthCredentialOwnership,
	expectedFingerprint?: string,
): NativeOAuthCredentialMutationResult {
	return nativeOAuthMutationResult(
		runHermesCodexAuthCommand(
			home,
			workspaceRoot,
			action,
			profileId,
			credentialRevision,
			material,
			ownership,
			expectedFingerprint,
		),
	);
}

function openClawAgentDir(home: string): string {
	return join(home, ".openclaw", "agents", "main", "agent");
}

function openClawProviderAuthSdkPath(
	observation: RuntimeInstallObservation | undefined,
	home: string,
): string {
	const testOverride = process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK?.trim();
	if (testOverride) {
		if (process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1") {
			throw new Error(
				"CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1",
			);
		}
		return testOverride;
	}
	const commandPath = observation?.commandPath;
	const resolved = resolveOpenClawProviderAuthSdkExport([
		commandPath,
		observation?.appRoot,
		join(home, ".openclaw", "lib", "node_modules", "openclaw"),
		join(home, ".openclaw", "node_modules", "openclaw"),
		join(home, ".local", "lib", "node_modules", "openclaw"),
	]);
	if (!resolved) throw new Error("installed OpenClaw provider-auth SDK export is unavailable");
	return resolved;
}

const OPENCLAW_PROVIDER_AUTH_CAPABILITY_PROBE = `
import { pathToFileURL } from "node:url";
const sdk = await import(pathToFileURL(process.argv[1]).href);
if (typeof sdk.ensureAuthProfileStoreForLocalUpdate !== "function" || typeof sdk.updateAuthProfileStoreWithLock !== "function") {
  throw new Error("required public provider-auth exports are missing");
}
`;

function requireOpenClawProviderAuthCapability(
	observation: RuntimeInstallObservation | undefined,
	home: string,
): void {
	const sdkPath = openClawProviderAuthSdkPath(observation, home);
	ensureRuntimeUserHome(home);
	const result = spawnRuntimeUserCommand(
		"node",
		["--input-type=module", "--eval", OPENCLAW_PROVIDER_AUTH_CAPABILITY_PROBE, sdkPath],
		home,
		home,
	);
	if (result.status !== 0) {
		throw new Error(
			`installed OpenClaw public provider-auth SDK is incompatible: ${
				tail(String(result.stderr ?? "")) ?? "capability probe failed"
			}`,
		);
	}
}

function ensureHostedOpenClawProviderAuthCapability(input: {
	manifest: RuntimeManifest;
	secretValues: Record<string, string> | undefined;
	observation: RuntimeInstallObservation;
	home: string;
}): RuntimeInstallObservation {
	const desired = hostedRuntimeOAuthCredentials(input.manifest, "openclaw", input.secretValues);
	if (desired.length === 0) return input.observation;
	try {
		requireOpenClawProviderAuthCapability(input.observation, input.home);
		return input.observation;
	} catch (initialError) {
		const install = input.manifest.runtimes.openclaw?.install;
		if (!install) {
			throw new Error(
				`OpenClaw OAuth requires the public provider-auth SDK, and no official installer repair is authorized: ${
					initialError instanceof Error ? initialError.message : String(initialError)
				}`,
			);
		}
		const repaired = runOfficialInstaller("openclaw", install, { force: true });
		if (repaired.error) {
			throw new Error(`OpenClaw provider-auth capability repair failed: ${repaired.error}`);
		}
		try {
			requireOpenClawProviderAuthCapability(repaired, input.home);
		} catch (repairError) {
			throw new Error(
				`OpenClaw provider-auth capability remains unavailable after official installer repair: ${
					repairError instanceof Error ? repairError.message : String(repairError)
				}`,
			);
		}
		return repaired;
	}
}

function runOpenClawProviderAuthCommand(
	observation: RuntimeInstallObservation | undefined,
	home: string,
	workspaceRoot: string,
	action: OpenClawProviderAuthAction,
	profileId: string,
	credentialRevision: string,
	material?: RuntimeOAuthMaterial,
	ownership?: OAuthCredentialOwnership,
	expectedFingerprint?: string,
): Record<string, unknown> {
	const credential = material
		? JSON.stringify({
				type: "oauth",
				provider: OPENCLAW_CODEX_PROVIDER_ID,
				access: material.accessToken,
				refresh: material.refreshToken,
				expires: material.expires,
				...(material.idToken ? { idToken: material.idToken } : {}),
				...(material.accountId ? { accountId: material.accountId } : {}),
				copyToAgents: false,
			})
		: "";
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_PROVIDER_AUTH_HELPER,
			openClawProviderAuthSdkPath(observation, home),
			openClawAgentDir(home),
			action,
			profileId,
			ownership?.nativeProfileId ?? "",
			credentialRevision,
			expectedFingerprint ?? "",
		],
		home,
		workspaceRoot,
		{ input: credential || "null" },
	);
	if (result.status !== 0) {
		throw new Error(
			`OpenClaw provider-auth ${action} failed: ${tail(String(result.stderr ?? "")) ?? "unknown"}`,
		);
	}
	const output = recordValue(JSON.parse(String(result.stdout || "{}")) as unknown);
	return output ?? {};
}

function observeOpenClawProviderAuth(
	observation: RuntimeInstallObservation | undefined,
	home: string,
	workspaceRoot: string,
	profileId: string,
	credentialRevision: string,
	ownership?: OAuthCredentialOwnership,
): NativeOAuthCredentialObservation {
	return nativeOAuthObservation(
		runOpenClawProviderAuthCommand(
			observation,
			home,
			workspaceRoot,
			"inspect",
			profileId,
			credentialRevision,
			undefined,
			ownership,
		),
	);
}

function runOpenClawProviderAuth(
	observation: RuntimeInstallObservation | undefined,
	home: string,
	workspaceRoot: string,
	action: Exclude<OpenClawProviderAuthAction, "inspect">,
	profileId: string,
	credentialRevision: string,
	material?: RuntimeOAuthMaterial,
	ownership?: OAuthCredentialOwnership,
	expectedFingerprint?: string,
): NativeOAuthCredentialMutationResult {
	return nativeOAuthMutationResult(
		runOpenClawProviderAuthCommand(
			observation,
			home,
			workspaceRoot,
			action,
			profileId,
			credentialRevision,
			material,
			ownership,
			expectedFingerprint,
		),
	);
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

function observeHostedRuntimeOAuthCredential(input: {
	runtime: "hermes" | "openclaw";
	observation?: RuntimeInstallObservation;
	home: string;
	workspaceRoot: string;
	nativeProfileId: string;
	credentialRevision: string;
	ownership?: OAuthCredentialOwnership;
}): NativeOAuthCredentialObservation {
	if (input.runtime === "hermes") {
		return observeHermesCodexAuth(
			input.home,
			input.workspaceRoot,
			input.nativeProfileId,
			input.credentialRevision,
			input.ownership,
		);
	}
	return observeOpenClawProviderAuth(
		input.observation,
		input.home,
		input.workspaceRoot,
		input.nativeProfileId,
		input.credentialRevision,
		input.ownership,
	);
}

function executeHostedRuntimeOAuthAction(input: {
	decision: ReturnType<typeof decideChatGptOAuthCredentialReconciliation>;
	runtime: "hermes" | "openclaw";
	observation?: RuntimeInstallObservation;
	home: string;
	workspaceRoot: string;
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
	let result: NativeOAuthCredentialMutationResult;
	if (input.runtime === "hermes") {
		result = runHermesCodexAuth(
			input.home,
			input.workspaceRoot,
			adapterAction,
			input.nativeProfileId,
			input.credentialRevision,
			input.material,
			undefined,
			expectedFingerprint,
		);
	} else {
		result = runOpenClawProviderAuth(
			input.observation,
			input.home,
			input.workspaceRoot,
			adapterAction,
			input.nativeProfileId,
			input.credentialRevision,
			input.material,
			undefined,
			expectedFingerprint,
		);
	}
	assertRuntimeNativeMutationCompleted(
		result,
		expectedFingerprint,
		targetFingerprint,
		`${input.runtime} OAuth credential`,
	);
}

function removeHostedRuntimeOAuthCredential(input: {
	runtime: "hermes" | "openclaw";
	observation?: RuntimeInstallObservation;
	home: string;
	workspaceRoot: string;
	nativeProfileId: string;
	credentialRevision: string;
	ownership: OAuthCredentialOwnership;
	expectedFingerprint: string;
}): void {
	let result: NativeOAuthCredentialMutationResult;
	if (input.runtime === "hermes") {
		result = runHermesCodexAuth(
			input.home,
			input.workspaceRoot,
			"remove",
			input.nativeProfileId,
			input.credentialRevision,
			undefined,
			input.ownership,
			input.expectedFingerprint,
		);
	} else {
		result = runOpenClawProviderAuth(
			input.observation,
			input.home,
			input.workspaceRoot,
			"remove",
			input.nativeProfileId,
			input.credentialRevision,
			undefined,
			input.ownership,
			input.expectedFingerprint,
		);
	}
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
	observation?: RuntimeInstallObservation;
	manifest: RuntimeManifest;
	secretValues: Record<string, string> | undefined;
	paths: RuntimePaths;
	home: string;
	workspaceRoot: string;
}): void {
	const desired = hostedRuntimeOAuthCredentials(input.manifest, input.runtime, input.secretValues);
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
			const native = observeHostedRuntimeOAuthCredential({
				runtime: input.runtime,
				observation: input.observation,
				home: input.home,
				workspaceRoot: input.workspaceRoot,
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
					runtime: input.runtime,
					observation: input.observation,
					home: input.home,
					workspaceRoot: input.workspaceRoot,
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
		const native = observeHostedRuntimeOAuthCredential({
			runtime: input.runtime,
			observation: input.observation,
			home: input.home,
			workspaceRoot: input.workspaceRoot,
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
			runtime: input.runtime,
			observation: input.observation,
			home: input.home,
			workspaceRoot: input.workspaceRoot,
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
	workspaceRoot: string,
	previousProviderIds: readonly string[],
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
				home,
				workspaceRoot,
			);
		}
		return { path: null, revision: null, providerIds: [...previousProviderIds] };
	}
	if (name === "hermes") {
		return withRuntimeUserFileAccess(() =>
			applyHostedHermesAiProviderProjection(
				observation,
				projectionInput,
				previousProviderIds,
				home,
			),
		);
	}
	if (name === "openclaw") {
		applyOpenClawGatewayHostedProjection(
			observation.commandPath,
			manifest,
			secretValues,
			home,
			workspaceRoot,
		);
		const providerPatch = buildOpenClawHostedProviderPatch(projectionInput, previousProviderIds);
		if (providerPatch.apply) {
			runRuntimeUserCommand(
				observation.commandPath,
				["config", "patch", "--stdin", ...providerPatch.args],
				providerPatch.content,
				home,
				workspaceRoot,
			);
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
			patch: providerPatch.content,
		});
	}
	return applyHostedHermesAiProviderProjection(
		observation,
		projectionInput,
		previousProviderIds,
		home,
		false,
	).revision;
}

function applyHostedCodexManagedProviderProjection(
	manifest: RuntimeManifest,
	home: string,
	codexCli: Record<string, string> | null,
): HostedAiProviderProjectionResult {
	const provider = hostedCodexManagedProvider(manifest);
	if (!provider) return { path: null, revision: null, providerIds: [] };

	const codexHome = hostedCodexHome(home);
	makeRuntimeUserPrivateDir(codexHome, home);
	const configPath = join(codexHome, CODEX_MANAGED_PROVIDER_CONFIG_FILE);
	const configContent = hostedCodexManagedConfigToml(provider);
	writePrivateFileAtomic(configPath, configContent, { mode: 0o600, dirMode: 0o700 });
	makeRuntimeUserOwned(configPath);
	makeRuntimeUserPrivateDir(codexHome, home);

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
	const model = stringValue(primaryModel?.model);
	if (
		codex?.enabled !== true ||
		!provider ||
		provider.managed_by !== "clawdi" ||
		apiMode !== "openai_responses" ||
		stringValue(provider.runtimeEnvName) !== CODEX_MANAGED_ENV_KEY ||
		normalizeSecretRef(stringValue(provider.apiKeySecretRef)) !== "secret://tool.codex.apiKey" ||
		!providerId ||
		stringValue(primaryModel?.provider_id) !== providerId ||
		!baseUrl ||
		!model
	) {
		return null;
	}
	return {
		baseUrl,
		model,
	};
}

function hostedCodexHome(home: string): string {
	return join(home, ".codex");
}

function hostedCodexManagedConfigToml(provider: HostedCodexManagedProvider): string {
	const lines = ["# Generated by Clawdi hosted runtime. Do not put API keys in this file."];
	lines.push(
		`model = ${quoteTomlString(provider.model)}`,
		`model_provider = ${quoteTomlString(CODEX_MANAGED_PROVIDER_ID)}`,
		"",
		`[model_providers.${CODEX_MANAGED_PROVIDER_ID}]`,
		`name = ${quoteTomlString("clawdi")}`,
		`base_url = ${quoteTomlString(provider.baseUrl)}`,
		`env_key = ${quoteTomlString(CODEX_MANAGED_ENV_KEY)}`,
		'wire_api = "responses"',
		"",
	);
	return lines.join("\n");
}

function ensureHostedCodexCli(paths: RuntimePaths): Record<string, string> | null {
	if (process.env.CLAWDI_CODEX_INSTALL_DISABLED === "1") return null;
	// Keep the exact managed package separate from the tenant's global npm tree:
	// ~/.local/bin/codex is the transparent-egress wrapper, while this XDG data
	// location holds the executable that the wrapper delegates to.
	const npmPrefix = paths.codexInstallRoot;
	const realBin = join(npmPrefix, "bin", "codex");
	const commandPath = paths.codexCommand;
	let installedVersion = hostedCodexInstalledVersion(npmPrefix);
	if (installedVersion !== CODEX_NPM_PACKAGE_VERSION || !executableExists(realBin)) {
		installHostedCodexCli(CODEX_NPM_PACKAGE_SPEC, npmPrefix, paths);
		installedVersion = hostedCodexInstalledVersion(npmPrefix);
	}
	if (installedVersion !== CODEX_NPM_PACKAGE_VERSION) {
		throw new Error(
			`Codex npm install produced version ${installedVersion ?? "unknown"}; expected ${CODEX_NPM_PACKAGE_VERSION}`,
		);
	}
	if (!executableExists(realBin)) {
		throw new Error(`Codex npm install did not create ${realBin}`);
	}
	withRuntimeUserFileAccess(() => writeHostedCodexCommandShim(commandPath, realBin));
	return {
		commandPath,
		npmPrefix,
		packageSpec: CODEX_NPM_PACKAGE_SPEC,
		packageVersion: installedVersion,
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
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

function installHostedCodexCli(packageSpec: string, npmPrefix: string, paths: RuntimePaths): void {
	if (!commandExists("npm")) {
		throw new Error("Codex runtime add-on install requires npm on PATH");
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
			`Codex runtime add-on install failed: ${tail(result.stderr?.toString()) ?? tail(result.stdout?.toString()) ?? "npm failed"}`,
		);
	}
}

function writeHostedCodexCommandShim(commandPath: string, realBin: string): void {
	const binDir = dirname(commandPath);
	mkdirSync(binDir, { recursive: true });
	writePrivateFileAtomic(
		commandPath,
		[
			"#!/usr/bin/env sh",
			`export ${CODEX_MANAGED_ENV_KEY}=${shellQuote(MANAGED_EGRESS_PLACEHOLDER_VALUE)}`,
			`exec ${shellQuote(realBin)} "$@"`,
			"",
		].join("\n"),
		{
			mode: 0o755,
			dirMode: 0o755,
		},
	);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function applyHostedHermesAiProviderProjection(
	observation: RuntimeInstallObservation,
	projectionInput: HostedAiProviderProjectionInput | null,
	previousProviderIds: readonly string[],
	home: string,
	apply = true,
): HostedAiProviderProjectionResult {
	const configPath = join(home, ".hermes", "config.yaml");
	if (apply) removeLegacyHermesModelProviderPlugin(home);
	if (!projectionInput) {
		const deletedProviderIds = existingHermesProviderIds(
			configPath,
			staleProviderIds(new Set(previousProviderIds), new Set()),
		);
		if (apply && deletedProviderIds.length > 0) {
			mergeHermesConfig(configPath, hermesProviderDeletePatch(deletedProviderIds));
			makeRuntimeUserOwned(configPath);
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
	);
	const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
	if (!file) throw new Error("Hermes projection did not include a config merge YAML file.");
	const activeProviderIds = [...hermesProviderIdsFromPatch(file.content)].sort();
	const deletedProviderIds = existingHermesProviderIds(
		configPath,
		staleProviderIds(new Set(previousProviderIds), new Set(activeProviderIds)),
	);
	const patchContent = mergeHermesProviderDeletes(file.content, deletedProviderIds);
	if (apply) {
		mergeHermesConfig(configPath, patchContent);
		makeRuntimeUserOwned(configPath);
	}
	return {
		path: configPath,
		providerIds: activeProviderIds,
		revision: runtimeImpactRevision({
			hermesProviderProjection: "yaml-merge",
			patch: patchContent,
		}),
	};
}

function quoteTomlString(value: string): string {
	return JSON.stringify(value);
}

function legacyHermesModelProviderPluginDir(home: string): string {
	return join(home, ".hermes", "plugins", "model-providers", "clawdi");
}

function removeLegacyHermesModelProviderPlugin(home: string): void {
	rmSync(legacyHermesModelProviderPluginDir(home), { recursive: true, force: true });
}

export interface OpenClawHostedProviderPatch {
	apply: boolean;
	args: string[];
	content: string;
	providerIds: string[];
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
	const providerIds = [...openClawProviderIdsFromPatch(file.content)].sort();
	const deletedProviderIds = staleProviderIds(new Set(previousProviderIds), new Set(providerIds));
	return {
		apply: true,
		args: openClawProviderModelReplacementArgs(file.content),
		content: mergeOpenClawProviderDeletes(file.content, deletedProviderIds),
		providerIds,
	};
}

function openClawProviderIdsFromPatch(content: string): Set<string> {
	const parsed = JSON.parse(content) as unknown;
	const root = recordValue(parsed);
	const models = root ? recordValue(root.models) : null;
	const providers = models ? recordValue(models.providers) : null;
	if (!providers) return new Set();
	return new Set(
		Object.entries(providers)
			.filter(([, value]) => value !== null)
			.map(([providerId]) => providerId),
	);
}

function openClawProviderModelReplacementArgs(content: string): string[] {
	const parsed = JSON.parse(content) as unknown;
	const root = recordValue(parsed);
	const models = root ? recordValue(root.models) : null;
	const providers = models ? recordValue(models.providers) : null;
	if (!providers) return [];
	return Object.entries(providers).flatMap(([providerId, provider]) => {
		const providerConfig = recordValue(provider);
		if (!providerConfig || !Array.isArray(providerConfig.models)) return [];
		return ["--replace-path", `models.providers[${JSON.stringify(providerId)}].models`];
	});
}

function mergeOpenClawProviderDeletes(
	patchContent: string,
	deletedProviderIds: readonly string[],
): string {
	if (deletedProviderIds.length === 0) return patchContent;
	const parsed = JSON.parse(patchContent) as unknown;
	const root = recordValue(parsed);
	if (!root) return patchContent;
	const patch = { ...root };
	const existingModels = recordValue(patch.models);
	const models: Record<string, unknown> = existingModels
		? { ...existingModels }
		: { mode: "merge" };
	const existingProviders = recordValue(models.providers);
	const providers = existingProviders ? { ...existingProviders } : {};
	for (const providerId of deletedProviderIds) {
		providers[providerId] = null;
	}
	models.mode = "merge";
	models.providers = providers;
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

function hermesProviderIdsFromPatch(content: string): Set<string> {
	if (!content.trim()) return new Set();
	const parsed = parseYaml(content) as unknown;
	const root = recordValue(parsed);
	const providers = root ? recordValue(root.providers) : null;
	if (!providers) return new Set();
	return new Set(
		Object.entries(providers)
			.filter(([, value]) => value !== null)
			.map(([providerId]) => providerId),
	);
}

function mergeHermesProviderDeletes(
	patchContent: string,
	deletedProviderIds: readonly string[],
): string {
	if (deletedProviderIds.length === 0) return patchContent;
	const parsed = parseYaml(patchContent) as unknown;
	const root = recordValue(parsed);
	if (!root) return patchContent;
	const patch = { ...root };
	const existingProviders = recordValue(patch.providers);
	const providers = existingProviders ? { ...existingProviders } : {};
	for (const providerId of deletedProviderIds) {
		providers[providerId] = null;
	}
	patch.providers = providers;
	return `${stringifyYaml(patch).trimEnd()}\n`;
}

function existingHermesProviderIds(configPath: string, providerIds: readonly string[]): string[] {
	if (providerIds.length === 0 || !existsSync(configPath)) return [];
	try {
		const parsed = parseYaml(readFileSync(configPath, "utf-8")) as unknown;
		const root = recordValue(parsed);
		const providers = root ? recordValue(root.providers) : null;
		if (!providers) return [];
		return providerIds.filter((providerId) => Object.hasOwn(providers, providerId));
	} catch {
		return [];
	}
}

function hermesProviderDeletePatch(deletedProviderIds: readonly string[]): string {
	return `${stringifyYaml({
		providers: Object.fromEntries(deletedProviderIds.map((providerId) => [providerId, null])),
	}).trimEnd()}\n`;
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
): Record<string, unknown> | null {
	const allowedOrigins = openClawControlUiAllowedOrigins(manifest);
	const gatewayToken = manifest.openclawGatewayAuth
		? runtimeSecretValue(secretValues ?? {}, manifest.openclawGatewayAuth.tokenRef)
		: null;
	const isHostedV2 = manifest.projection?.sourceBundleVersion === "clawdi.hosted-runtime.bundle.v2";
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
													allowInsecureAuth: false,
													dangerouslyAllowHostHeaderOriginFallback: false,
													dangerouslyDisableDeviceAuth: true,
												}
											: { dangerouslyDisableDeviceAuth: true }),
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
		value === null ? !Object.hasOwn(current, key) : jsonMergePatchIsApplied(current[key], value),
	);
}

function openClawGatewayHostedPatchIsApplied(
	home: string,
	patch: Record<string, unknown>,
): boolean {
	try {
		const current = JSON.parse(
			readFileSync(join(home, ".openclaw", "openclaw.json"), "utf-8"),
		) as unknown;
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
	home: string,
	workspaceRoot: string,
): void {
	const patch = openClawGatewayHostedPatch(manifest, secretValues);
	if (!patch || openClawGatewayHostedPatchIsApplied(home, patch)) return;
	runRuntimeUserCommand(
		command,
		["config", "patch", "--stdin"],
		`${JSON.stringify(patch, null, 2)}\n`,
		home,
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

function applyHostedChannelProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	workspaceRoot: string,
): string | null {
	if (name !== "openclaw" && name !== "hermes") return null;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return null;
	}
	const channels = hostedChannelProjection(manifest);
	if (!channels) return null;

	if (name === "hermes") {
		const configPath = join(home, ".hermes", "config.yaml");
		withRuntimeUserFileAccess(() => {
			mergeHermesChannelConfig(
				configPath,
				hermesManagedChannelsPatch(channels, manifest.projection?.channelCredentials),
			);
			makeRuntimeUserOwned(configPath);
		});
		return configPath;
	}
	runRuntimeUserCommand(
		observation.commandPath,
		["config", "patch", "--stdin", ...openClawManagedAccountReplaceArgs(channels)],
		`${JSON.stringify(openClawManagedChannelsPatch(channels), null, 2)}\n`,
		home,
		workspaceRoot,
	);
	return observation.commandPath;
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

function hermesManagedChannelsPatch(
	channels: Record<string, unknown>,
	channelCredentials: unknown,
): Record<string, unknown> {
	const telegramEnabled = channelHasAccounts(channels.telegram);
	const discordEnabled = channelHasAccounts(channels.discord);
	const whatsappEnabled = channelHasAccounts(channels.whatsapp);
	const whatsappSessionPath = whatsappEnabled
		? hermesManagedWhatsAppSessionPath(channelCredentials)
		: null;
	if (whatsappEnabled && !whatsappSessionPath) {
		throw new Error("managed Hermes WhatsApp projection is missing its auth directory");
	}
	const sharedChannelSessionsEnabled = telegramEnabled || discordEnabled || whatsappEnabled;
	return {
		telegram: telegramEnabled
			? {
					enabled: true,
					dm_policy: "open",
					group_policy: "open",
					allow_from: ["*"],
					group_allow_from: ["*"],
					group_allowed_chats: ["*"],
					require_mention: false,
					extra: {
						base_url: "https://api.telegram.org/bot",
						base_file_url: "https://api.telegram.org/file/bot",
					},
				}
			: { enabled: false },
		discord: discordEnabled
			? {
					enabled: true,
					dm_policy: "open",
					group_policy: "open",
					require_mention: false,
					thread_require_mention: false,
					bots_require_inline_mention: false,
				}
			: { enabled: false },
		...(whatsappEnabled
			? {
					whatsapp: {
						enabled: true,
						dm_policy: "allowlist",
						group_policy: "open",
						allow_from: ["*"],
						group_allow_from: ["*"],
					},
				}
			: {}),
		group_sessions_per_user: sharedChannelSessionsEnabled ? false : null,
		thread_sessions_per_user: sharedChannelSessionsEnabled ? false : null,
		platforms: {
			telegram: {
				extra: {
					group_sessions_per_user: telegramEnabled ? false : null,
					thread_sessions_per_user: telegramEnabled ? false : null,
				},
			},
			...(whatsappEnabled
				? {
						whatsapp: {
							enabled: true,
							extra: {
								session_path: whatsappSessionPath,
								dm_policy: "allowlist",
								group_policy: "open",
								allow_from: ["*"],
								group_allow_from: ["*"],
								group_sessions_per_user: false,
								thread_sessions_per_user: false,
							},
						},
					}
				: {}),
		},
		display: {
			platforms: {
				telegram: {
					streaming: telegramEnabled ? true : null,
				},
			},
		},
	};
}

function hermesManagedWhatsAppSessionPath(channelCredentials: unknown): string | null {
	if (!Array.isArray(channelCredentials)) return null;
	for (const value of channelCredentials) {
		const credential = recordValue(value);
		if (credential?.provider !== "whatsapp" || credential.kind !== "whatsapp_baileys_auth_state") {
			continue;
		}
		const targets = recordValue(credential.targets);
		const hermes = recordValue(targets?.hermes);
		const authDir = stringValue(hermes?.authDir);
		if (authDir) return authDir;
	}
	return null;
}

function channelHasAccounts(channel: unknown): boolean {
	if (!isPlainRecord(channel)) return false;
	const accounts = channel.accounts;
	return isPlainRecord(accounts) && Object.keys(accounts).length > 0;
}

function openClawManagedChannelUsesEnvSecretRefs(channels: Record<string, unknown>): boolean {
	return ["telegram", "discord", "whatsapp"].some((channel) =>
		channelHasAccounts(channels[channel]),
	);
}

function openClawManagedChannelsPatch(channels: Record<string, unknown>): Record<string, unknown> {
	const deleteEntries = openClawManagedChannelDeletes();
	const usesEnvSecretRefs = openClawManagedChannelUsesEnvSecretRefs(channels);
	const isolatesManagedDms =
		channelHasAccounts(channels.telegram) ||
		channelHasAccounts(channels.discord) ||
		channelHasAccounts(channels.whatsapp);
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
			runRuntimeUserCommand(commandPath, ["plugins", "install", spec], "", home, workspaceRoot);
			return;
		} catch (error) {
			if (isOpenClawPluginAlreadyInstalledError(error)) return;
			lastError = error;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error(`OpenClaw plugin install failed for ${specs.join(" or ")}`);
}

function isOpenClawPluginAlreadyInstalledError(error: unknown): boolean {
	const text = commandErrorText(error).toLowerCase();
	return text.includes("plugin already exists:");
}

function commandErrorText(error: unknown): string {
	if (typeof error !== "object" || error === null) return String(error);
	const parts: string[] = [];
	const output = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
	for (const value of [output.message, output.stdout, output.stderr]) {
		if (typeof value === "string") parts.push(value);
		else if (Buffer.isBuffer(value)) parts.push(value.toString("utf8"));
	}
	return parts.join("\n");
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

function hostedBundledSkillSourceDir(assetDirectory: string): string {
	const sourceDir = resolve(resolveCurrentCliResourceRoot(), "skills", assetDirectory);
	if (!existsSync(join(sourceDir, "SKILL.md"))) {
		throw new Error(`bundled hosted skill asset ${assetDirectory} is unavailable`);
	}
	return sourceDir;
}

function hostedBundledSkillTargetDir(
	name: string,
	skillName: string,
	home: string,
	openClawWorkspaceRoot?: string,
): string | null {
	if (name !== "openclaw" && name !== "hermes") return null;
	if (name === "openclaw") {
		return openClawWorkspaceRoot ? join(openClawWorkspaceRoot, "skills", skillName) : null;
	}
	return agentSkillTargetDir(name, skillName, join(home, ".hermes"));
}

function managedSkillReservationDigest(targetDir: string, skillId: string): string {
	const reservation = managedSkillReservations("hosted-manifest").find(
		(entry) => entry.targetDir === targetDir && entry.id === skillId,
	);
	if (!reservation) throw new Error(`managed Skill ${skillId} has no matching ownership receipt`);
	if (!reservation.digest) throw new Error(`managed Skill ${skillId} has no content digest`);
	return reservation.digest;
}

function managedSkillReservationSourceIdentity(targetDir: string, skillId: string): string {
	const reservation = managedSkillReservations("hosted-manifest").find(
		(entry) => entry.targetDir === targetDir && entry.id === skillId,
	);
	if (!reservation?.sourceIdentity)
		throw new Error(`managed Skill ${skillId} has no canonical source identity`);
	return reservation.sourceIdentity;
}

function validateHostedSkillsPlan(
	name: string,
	manifest: RuntimeManifest,
	home: string,
	openClawWorkspaceRoot: string | null,
	preparedSourcedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): void {
	if (!hostedBundledSkillsEnabled()) return;
	if (name === "openclaw" && !openClawWorkspaceRoot) {
		if (manifest.runtimes.openclaw?.enabled === true) {
			throw new Error("OpenClaw official agent workspace is unavailable");
		}
		return;
	}
	for (const [skillName, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		const targetDir = hostedBundledSkillTargetDir(
			name,
			skillName,
			home,
			openClawWorkspaceRoot ?? undefined,
		);
		const runtimeEnabled = manifest.runtimes[name]?.enabled === true;
		if ("source" in desired) {
			if (hostedBundledSkillIds().includes(skillName)) {
				throw new Error(`bundled hosted Skill ${skillName} must not declare a catalog source`);
			}
			if (
				(name !== "hermes" && name !== "openclaw") ||
				!targetDir ||
				!runtimeEnabled ||
				desired.enabled !== true
			)
				continue;
			const prepared = preparedSourcedSkills.get(skillName);
			if (!prepared || JSON.stringify(prepared.source) !== JSON.stringify(desired.source)) {
				throw new Error(`pinned archive for hosted Skill ${skillName} is unavailable`);
			}
			const reservationOwner = managedSkillReservationOwner(targetDir, skillName);
			if (existsSync(targetDir) && reservationOwner !== "hosted-manifest") {
				throw new Error(`refusing to replace unmanaged ${skillName} skill at ${targetDir}`);
			}
			continue;
		}
		const bundled = resolveHostedBundledSkill(skillName, desired.version);
		if (!targetDir || !runtimeEnabled || desired.enabled !== true) continue;
		const sourceDir = hostedBundledSkillSourceDir(bundled.assetDirectory);
		assertHostedBundledSkillCatalogDigest(bundled, sourceDir);
		const reservationOwner = managedSkillReservationOwner(targetDir, skillName);
		if (
			existsSync(targetDir) &&
			reservationOwner !== "hosted-manifest" &&
			!adoptableLegacyHostedBundledSkill(targetDir, skillName)
		) {
			throw new Error(`refusing to replace unmanaged ${skillName} skill at ${targetDir}`);
		}
	}
}

function recoverHostedSourcedSkillReservations(
	manifest: RuntimeManifest,
	home: string,
	preparedSourcedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
	nativeReconciler: HostedHermesSkillExactSourceDriver,
): void {
	if (!hostedBundledSkillsEnabled() || manifest.runtimes.hermes?.enabled !== true) return;
	const appRoot = join(home, ".hermes", "hermes-agent");
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {}).sort(
		([left], [right]) => left.localeCompare(right),
	)) {
		if (
			desired.enabled !== true ||
			!("source" in desired) ||
			hostedBundledSkillIds().includes(skillId)
		) {
			continue;
		}
		const targetDir = hostedBundledSkillTargetDir("hermes", skillId, home);
		if (
			!targetDir ||
			!existsSync(targetDir) ||
			managedSkillReservationOwner(targetDir, skillId) !== "unreserved"
		) {
			continue;
		}
		const prepared = preparedSourcedSkills.get(skillId);
		if (!prepared || JSON.stringify(prepared.source) !== JSON.stringify(desired.source)) {
			continue;
		}
		if (!nativeReconciler.verifyOwned({ home, appRoot, skill: prepared })) continue;
		reserveManagedSkill({
			targetDir,
			id: skillId,
			manager: "hosted-manifest",
			sourceIdentity: prepared.sourceIdentity,
		});
	}
}

function recoverHostedOpenClawSourcedSkillReservations(
	manifest: RuntimeManifest,
	openClawWorkspaceRoot: string,
	prepared: ReadonlyMap<string, PreparedHostedSourcedSkill>,
	driver: HostedOpenClawSkillDriver,
): void {
	if (!hostedBundledSkillsEnabled() || manifest.runtimes.openclaw?.enabled !== true) return;
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		if (
			desired.enabled !== true ||
			!("source" in desired) ||
			hostedBundledSkillIds().includes(skillId)
		)
			continue;
		const targetDir = join(openClawWorkspaceRoot, "skills", skillId);
		if (!existsSync(targetDir) || managedSkillReservationOwner(targetDir, skillId) !== "unreserved")
			continue;
		const skill = prepared.get(skillId);
		if (
			!skill ||
			JSON.stringify(skill.source) !== JSON.stringify(desired.source) ||
			!driver.verifyOwned({ workspaceRoot: openClawWorkspaceRoot, skill })
		)
			continue;
		reserveManagedSkill({
			targetDir,
			id: skillId,
			manager: "hosted-manifest",
			sourceIdentity: skill.sourceIdentity,
		});
	}
}

function recoverHostedOpenClawBundledSkillReservations(
	manifest: RuntimeManifest,
	openClawWorkspaceRoot: string,
	driver: HostedOpenClawSkillDriver,
): void {
	if (!hostedBundledSkillsEnabled() || manifest.runtimes.openclaw?.enabled !== true) return;
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		if (desired.enabled !== true || "source" in desired) continue;
		const targetDir = join(openClawWorkspaceRoot, "skills", skillId);
		if (!existsSync(targetDir) || managedSkillReservationOwner(targetDir, skillId) !== "unreserved")
			continue;
		const bundled = resolveHostedBundledSkill(skillId, desired.version);
		if (
			!driver.hasOwnershipReceipt({
				workspaceRoot: openClawWorkspaceRoot,
				skillId,
				ownershipIdentity: `content-sha256\0${bundled.digest}`,
			})
		)
			continue;
		reserveManagedSkill({
			targetDir,
			id: skillId,
			manager: "hosted-manifest",
			version: bundled.version,
			digest: bundled.digest,
		});
	}
}

function applyHostedBundledSkills(
	name: string,
	observation: RuntimeInstallObservation | undefined,
	manifest: RuntimeManifest,
	home: string,
	openClawWorkspaceRoot: string | null,
	openClawDriver: HostedOpenClawSkillDriver,
): string[] {
	// Reservation state is root-authoritative. Drop privilege only inside the
	// callbacks that mutate runtime-user-owned Skill trees.
	const installEnabled = hostedBundledSkillsEnabled();
	if (name === "openclaw" && !openClawWorkspaceRoot) return [];
	const requireOpenClawWorkspace = (): string => {
		if (!openClawWorkspaceRoot) throw new Error("OpenClaw official agent workspace is unavailable");
		return openClawWorkspaceRoot;
	};
	const targets: string[] = [];
	for (const skillName of hostedBundledSkillIds()) {
		const targetDir = hostedBundledSkillTargetDir(
			name,
			skillName,
			home,
			openClawWorkspaceRoot ?? undefined,
		);
		if (!targetDir) continue;
		targets.push(targetDir);
		const desired = manifest.projection?.skills?.entries[skillName];
		const runtimeEnabled = manifest.runtimes[name]?.enabled === true;
		if (desired && "source" in desired) {
			throw new Error(`bundled hosted Skill ${skillName} must not declare a catalog source`);
		}
		if (!installEnabled || !runtimeEnabled || desired?.enabled !== true) {
			const reservationOwner = managedSkillReservationOwner(targetDir, skillName);
			const legacy = adoptableLegacyHostedBundledSkill(targetDir, skillName);
			const legacyAdopted = Boolean(legacy && reservationOwner === "unreserved");
			if (reservationOwner === "local-setup") continue;
			if (!installEnabled && reservationOwner === "unreserved" && !legacy) continue;
			if (legacy && reservationOwner === "unreserved") {
				reserveManagedSkill({
					targetDir,
					id: skillName,
					manager: "hosted-manifest",
					version: legacy.version,
					digest: legacy.digest,
				});
			}
			releaseManagedSkill({
				targetDir,
				id: skillName,
				manager: "hosted-manifest",
				removeTarget: () =>
					name === "openclaw" && !legacyAdopted
						? openClawDriver.cleanupManifestOwned({
								workspaceRoot: requireOpenClawWorkspace(),
								skillId: skillName,
								ownershipIdentity: `content-sha256\0${managedSkillReservationDigest(targetDir, skillName)}`,
							})
						: withRuntimeUserFileAccess(() => rmSync(targetDir, { recursive: true, force: true })),
			});
			continue;
		}
		if (!observation?.enabled || observation.status === "install_failed") continue;
		const catalogEntry = resolveHostedBundledSkill(skillName, desired.version);
		const reservationOwner = managedSkillReservationOwner(targetDir, skillName);
		if (
			existsSync(targetDir) &&
			reservationOwner !== "hosted-manifest" &&
			!adoptableLegacyHostedBundledSkill(targetDir, skillName)
		) {
			throw new Error(`refusing to replace unmanaged ${skillName} skill at ${targetDir}`);
		}
		const bundled = catalogEntry;
		const sourceDir = hostedBundledSkillSourceDir(bundled.assetDirectory);
		// Root captures and verifies the source before the callback drops to the
		// runtime identity. The callback can only mutate the target from bytes.
		const bundle = loadHostedBundledSkill(skillName, desired.version, sourceDir);
		const result = installReservedManagedSkill(
			{
				targetDir,
				id: skillName,
				manager: "hosted-manifest",
				version: desired.version,
				digest: bundled.digest,
			},
			() =>
				name === "openclaw"
					? withStagedHostedBundledSkill(bundle, (stagedSourceDir) =>
							openClawDriver.installDirectory({
								home,
								workspaceRoot: requireOpenClawWorkspace(),
								skillId: skillName,
								sourceDir: stagedSourceDir,
								ownershipIdentity: `content-sha256\0${bundled.digest}`,
							}),
						)
					: withRuntimeUserFileAccess(() =>
							reconcileHostedBundledSkill({ bundle, targetDir, reserved: true }),
						),
		);
		if (result === "unchanged") continue;
	}
	return targets;
}

function applyHostedSourcedSkills(
	observation: RuntimeInstallObservation | undefined,
	manifest: RuntimeManifest,
	home: string,
	preparedSourcedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
	nativeReconciler: HostedHermesSkillExactSourceDriver,
): string[] {
	const skillsRoot = join(home, ".hermes", "skills");
	const desiredEntries = manifest.projection?.skills?.entries ?? {};
	const desiredCatalogIds = Object.entries(desiredEntries).flatMap(([skillId, desired]) =>
		"source" in desired ? [skillId] : [],
	);
	const previouslyManagedIds = managedSkillReservations("hosted-manifest").flatMap((reservation) =>
		dirname(reservation.targetDir) === skillsRoot &&
		!hostedBundledSkillIds().includes(reservation.id)
			? [reservation.id]
			: [],
	);
	const skillIds = [...new Set([...desiredCatalogIds, ...previouslyManagedIds])].sort(
		(left, right) => left.localeCompare(right),
	);
	const appRoot = join(home, ".hermes", "hermes-agent");
	const runtimeEnabled = manifest.runtimes.hermes?.enabled === true;
	const targets: string[] = [];
	for (const skillId of skillIds) {
		const targetDir = hostedBundledSkillTargetDir("hermes", skillId, home);
		if (!targetDir) continue;
		targets.push(targetDir);
		const desired = desiredEntries[skillId];
		if (!runtimeEnabled || desired?.enabled !== true || !("source" in desired)) {
			const owner = managedSkillReservationOwner(targetDir, skillId);
			if (owner === "unreserved") continue;
			if (owner !== "hosted-manifest") {
				throw new Error(`managed Skill ${skillId} is owned by a different manager`);
			}
			releaseManagedSkill({
				targetDir,
				id: skillId,
				manager: "hosted-manifest",
				removeTarget: () =>
					nativeReconciler.uninstall({
						home,
						appRoot,
						skillId,
						ownershipIdentity: managedSkillReservationSourceIdentity(targetDir, skillId),
					}),
			});
			continue;
		}
		if (!observation?.enabled || observation.status === "install_failed") continue;
		const prepared = preparedSourcedSkills.get(skillId);
		if (!prepared) throw new Error(`pinned archive for hosted Skill ${skillId} is unavailable`);
		const owner = managedSkillReservationOwner(targetDir, skillId);
		if (existsSync(targetDir) && owner !== "hosted-manifest") {
			throw new Error(`refusing to replace unmanaged ${skillId} skill at ${targetDir}`);
		}
		installReservedManagedSkill(
			{
				targetDir,
				id: skillId,
				manager: "hosted-manifest",
				sourceIdentity: prepared.sourceIdentity,
			},
			() =>
				nativeReconciler.install({
					home,
					appRoot,
					skill: prepared,
					previouslyReserved: owner === "hosted-manifest",
				}),
		);
	}
	return targets;
}

function applyHostedOpenClawSourcedSkills(
	observation: RuntimeInstallObservation | undefined,
	manifest: RuntimeManifest,
	home: string,
	openClawWorkspaceRoot: string,
	preparedSourcedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
	driver: HostedOpenClawSkillDriver,
): string[] {
	const skillsRoot = join(openClawWorkspaceRoot, "skills");
	const desiredEntries = manifest.projection?.skills?.entries ?? {};
	const desiredIds = Object.entries(desiredEntries).flatMap(([id, desired]) =>
		"source" in desired ? [id] : [],
	);
	const managedIds = managedSkillReservations("hosted-manifest").flatMap((reservation) =>
		dirname(reservation.targetDir) === skillsRoot &&
		!hostedBundledSkillIds().includes(reservation.id)
			? [reservation.id]
			: [],
	);
	const ids = [...new Set([...desiredIds, ...managedIds])].sort((left, right) =>
		left.localeCompare(right),
	);
	for (const skillId of ids) {
		const targetDir = join(skillsRoot, skillId);
		const desired = desiredEntries[skillId];
		if (
			manifest.runtimes.openclaw?.enabled !== true ||
			desired?.enabled !== true ||
			!("source" in desired)
		) {
			const owner = managedSkillReservationOwner(targetDir, skillId);
			if (owner === "unreserved") continue;
			if (owner !== "hosted-manifest")
				throw new Error(`managed Skill ${skillId} is owned by a different manager`);
			releaseManagedSkill({
				targetDir,
				id: skillId,
				manager: "hosted-manifest",
				removeTarget: () =>
					driver.cleanupManifestOwned({
						workspaceRoot: openClawWorkspaceRoot,
						skillId,
						ownershipIdentity: managedSkillReservationSourceIdentity(targetDir, skillId),
					}),
			});
			continue;
		}
		if (!observation?.enabled || observation.status === "install_failed") continue;
		const prepared = preparedSourcedSkills.get(skillId);
		if (!prepared) throw new Error(`pinned archive for hosted Skill ${skillId} is unavailable`);
		const owner = managedSkillReservationOwner(targetDir, skillId);
		if (existsSync(targetDir) && owner !== "hosted-manifest")
			throw new Error(`refusing to replace unmanaged ${skillId} skill at ${targetDir}`);
		installReservedManagedSkill(
			{
				targetDir,
				id: skillId,
				manager: "hosted-manifest",
				sourceIdentity: prepared.sourceIdentity,
			},
			() => driver.install({ home, workspaceRoot: openClawWorkspaceRoot, skill: prepared }),
		);
	}
	return ids.map((id) => join(skillsRoot, id));
}

type HostedSkillProjectionEntry =
	| { id: string; version: number; digest: string }
	| { id: string; source: HostedSkillSource };

function hostedSkillProjection(
	manifest: RuntimeManifest,
	runtime: string,
): HostedSkillProjectionEntry[] | null {
	if (runtime !== "openclaw" && runtime !== "hermes") return null;
	if (manifest.runtimes[runtime]?.enabled !== true) return [];
	const projection: HostedSkillProjectionEntry[] = [];
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {}).sort(
		([left], [right]) => left.localeCompare(right),
	)) {
		if (desired.enabled !== true) continue;
		if ("source" in desired) {
			projection.push({ id: skillId, source: desired.source });
			continue;
		}
		const bundled = resolveHostedBundledSkill(skillId, desired.version);
		projection.push({ id: bundled.id, version: bundled.version, digest: bundled.digest });
	}
	return projection;
}

function applyHostedMcpProjections(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
	workspaceRoot: string,
): string[] {
	const plan = buildHostedMcpReconciliationPlan(manifest, paths, observations);
	const ledgerPath = hostedMcpLedgerPath(paths);
	const outputs = new Set<string>();
	// Hermes is one staged atomic file write. Apply it before OpenClaw so the
	// forward-convergence group completes before the root-owned ledger advances.
	for (const runtime of [...plan.runtimes].sort((left, right) =>
		left.name === right.name ? 0 : left.name === "hermes" ? -1 : 1,
	)) {
		if (runtime.mutations.length === 0) continue;
		if (runtime.name === "hermes") {
			if (runtime.nextHermesContent === null) {
				throw new Error("Hermes MCP reconciliation did not produce staged config");
			}
			const nextHermesContent = runtime.nextHermesContent;
			withRuntimeUserFileAccess(() => {
				writePrivateFileAtomic(runtime.native.path, nextHermesContent);
				makeRuntimeUserOwned(runtime.native.path);
			});
			outputs.add(runtime.native.path);
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
	path: string;
	content: string | null;
	servers: Record<string, unknown>;
}

interface HostedMcpRuntimePlan {
	name: HostedMcpTarget;
	native: HostedMcpNativeState;
	mutations: HostedMcpMutation[];
	commandPath: string | null;
	nextHermesContent: string | null;
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
		const native = readHostedMcpNativeState(name, home);
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
		const observation = observations.get(name);
		const hasSet = mutations.some((mutation) => mutation.kind === "set");
		if (hasSet && (!observation?.enabled || observation.status === "install_failed")) {
			throw new Error(`could not apply managed ${name} MCP servers: runtime is unavailable`);
		}
		const commandPath =
			name === "openclaw" ? (observation?.commandPath ?? runtimeCommandPath(name, home)) : null;
		let nextHermesContent: string | null = null;
		if (name === "hermes" && mutations.length > 0) {
			nextHermesContent = native.content ?? "";
			for (const mutation of mutations) {
				nextHermesContent =
					mutation.kind === "remove"
						? renderHermesMcpServerRemoval(nextHermesContent, mutation.serverName)
						: renderHermesMcpServer(nextHermesContent, mutation.serverName, mutation.server);
			}
		}
		return { name, native, mutations, commandPath, nextHermesContent };
	});
	return { home, runtimes, nextLedger };
}

function readHostedMcpNativeState(name: HostedMcpTarget, home: string): HostedMcpNativeState {
	const path =
		name === "openclaw"
			? join(home, ".openclaw", "openclaw.json")
			: join(home, ".hermes", "config.yaml");
	if (!existsSync(path)) return { path, content: null, servers: {} };
	const content = readFileSync(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = name === "openclaw" ? JSON.parse(content) : parseYaml(content);
	} catch (error) {
		throw new Error(
			`${name} config is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (parsed === null && name === "hermes") return { path, content, servers: {} };
	if (!isPlainRecord(parsed)) throw new Error(`${name} config must be an object`);
	if (name === "openclaw" && parsed.mcpServers !== undefined) {
		throw new Error(
			"openclaw config uses unsupported legacy field mcpServers; canonical MCP state is mcp.servers",
		);
	}
	const mcp = name === "openclaw" ? parsed.mcp : parsed;
	if (name === "openclaw" && mcp !== undefined && !isPlainRecord(mcp)) {
		throw new Error("openclaw config field mcp must be an object");
	}
	const field = name === "openclaw" ? "servers" : "mcp_servers";
	const servers = isPlainRecord(mcp) ? mcp[field] : undefined;
	if (servers === undefined) return { path, content, servers: {} };
	if (!isPlainRecord(servers)) {
		throw new Error(
			`${name} config field ${name === "openclaw" ? "mcp.servers" : field} must be an object`,
		);
	}
	return { path, content, servers };
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
		installerCommand: ["plugins", "install"],
		specs: input.specs,
	});
}

function channelPluginCurrentRevision(input: {
	channel: string;
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
		manifest.projection?.sourceBundleVersion === "clawdi.hosted-runtime.bundle.v2" &&
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
	providerProjectionRevision: string | null = null,
): string {
	const desiredRuntime = manifest.runtimes[runtime];
	const runtimeSecretRefs = desiredRuntime
		? Object.values(
				mergeRuntimeSecretEnv(
					runtime,
					desiredRuntime,
					hostedProviderEnvironment(manifest, runtime).secretEnv,
				),
			)
		: [];
	const channels = hostedChannelProjection(manifest);
	const hostedTarget = runtime === "openclaw" || runtime === "hermes";
	let channelProjection: Record<string, unknown> | null = null;
	if (channels && runtime === "openclaw") {
		channelProjection = openClawManagedChannelsPatch(channels);
	} else if (channels && runtime === "hermes" && desiredRuntime?.enabled) {
		channelProjection = hermesManagedChannelsPatch(
			channels,
			manifest.projection?.channelCredentials,
		);
	}
	return runtimeProgramRevision({
		renderedProjection: {
			channels: channelProjection,
			gateway: runtime === "openclaw" ? openClawGatewayHostedPatch(manifest, secretValues) : null,
			locale:
				manifest.locale && hostedTarget
					? managedLocaleBlock(manifest.locale)
					: (manifest.locale?.timezone ?? null),
			mcp: hostedTarget ? hostedMcpIntent(manifest) : null,
			provider: providerProjectionRevision,
			skills: hostedSkillProjection(manifest, runtime),
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

function validateRuntimeManifestPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	openClawWorkspaceRoot: string | null,
	preparedSourcedSkills: ReadonlyMap<string, PreparedHostedSourcedSkill>,
): void {
	const home = hostedRuntimeProjectionHome(manifest, paths);
	for (const name of HOSTED_RUNTIME_TARGETS) {
		validateHostedSkillsPlan(name, manifest, home, openClawWorkspaceRoot, preparedSourcedSkills);
	}
	for (const [name, runtime] of Object.entries(manifest.runtimes)) {
		const runtimeName = runtimeNameSchema.parse(name);
		const providerEnvironment = runtime.enabled
			? hostedProviderEnvironment(manifest, name, { validateOverlap: true })
			: { placeholderEnv: {}, secretEnv: {} };
		const { placeholderEnv: providerPlaceholderEnv, secretEnv: providerSecretEnv } =
			providerEnvironment;
		mergeRuntimeEnvWithProviderPlaceholders(name, runtime.run, providerPlaceholderEnv);
		const secretEnv = runtime.enabled
			? mergeRuntimeSecretEnv(name, runtime, providerSecretEnv)
			: {};
		for (const [serviceName, serviceSettings] of Object.entries(runtime.services ?? {})) {
			const service = runtimeServiceNameSchema.parse(serviceName);
			const settings = resolvedRuntimeServiceSettings(
				manifest,
				runtimeName,
				service,
				serviceSettings,
				providerPlaceholderEnv,
			);
			if (runtime.enabled) mergeRuntimeServiceSecretEnv(name, service, settings, secretEnv);
		}
		if (!runtime.enabled || !manifest.locale) continue;
		const block = managedLocaleBlock(manifest.locale);
		if (runtimeName === "openclaw") {
			if (!openClawWorkspaceRoot)
				throw new Error("OpenClaw official agent workspace is unavailable");
			nextManagedLocaleFileContent(join(openClawWorkspaceRoot, "SOUL.md"), block);
		} else if (runtimeName === "hermes") {
			nextManagedLocaleFileContent(join(home, ".hermes", "SOUL.md"), block);
		}
	}
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

function hermesDashboardServiceSettings(
	manifest: RuntimeManifest,
	runtime: RuntimeName,
	service: RuntimeServiceName,
	settings: RuntimeRunSettings,
): RuntimeRunSettings {
	if (runtime !== "hermes" || service !== "dashboard") return settings;
	const auth = manifest.hermesDashboardAuth;
	if (!auth) return settings;
	if (!auth.activation.enabled) {
		throw new Error("Hermes password authentication is disabled");
	}
	return {
		...settings,
		env: {
			...(settings?.env ?? {}),
			HERMES_DASHBOARD_BASIC_AUTH_USERNAME: auth.username,
			HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS: String(auth.sessionTtlSeconds),
			HERMES_DASHBOARD_PUBLIC_URL: auth.publicUrl,
		},
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
	const runtimeRunSettings = mergeRuntimeEnvWithProviderPlaceholders(
		input.name,
		input.runtime.run,
		providerPlaceholderEnv,
	);
	const secretEnv = input.runtime.enabled
		? mergeRuntimeSecretEnv(input.name, input.runtime, providerSecretEnv)
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
					? mergeRuntimeServiceSecretEnv(input.name, service, settings, secretEnv)
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
		projectedProviderIds: input.projectedProviderIds,
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
			instanceSemaphores: [],
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
}): void {
	const {
		manifest,
		paths,
		openClawWorkspaceRoot,
		secretValues,
		observations,
		previousProjectedProviderIds,
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

	let hermesConfig = existsSync(join(home, ".hermes", "config.yaml"))
		? readFileSync(join(home, ".hermes", "config.yaml"), "utf-8")
		: "";
	if (manifest.locale && Object.hasOwn(manifest.runtimes, "hermes")) {
		hermesConfig = renderHermesRuntimeLocale(hermesConfig, manifest.locale.timezone);
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
		mergeRuntimeEnvWithProviderPlaceholders(name, runtime.run, providerPlaceholderEnv);
		const secretEnv = runtime.enabled
			? mergeRuntimeSecretEnv(name, runtime, providerSecretEnv)
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
			mergeRuntimeServiceSecretEnv(name, service, settings, secretEnv);
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
			JSON.stringify(openClawGatewayHostedPatch(manifest, secretValues));
		}
		if (name === "hermes") {
			if (projectionInput) {
				const yamlProjection = buildAgentTargetProjection(
					"hermes",
					projectionInput.catalog,
					projectionInput.primaryModel,
				);
				const yamlFile = yamlProjection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
				if (!yamlFile)
					throw new Error("Hermes projection did not include a config merge YAML file.");
				hermesConfig = renderHermesConfig(hermesConfig, yamlFile.content);
			} else if (
				!configuredProjectionUnavailable &&
				(previousProjectedProviderIds.hermes ?? []).length > 0
			) {
				hermesConfig = renderHermesConfig(
					hermesConfig,
					hermesProviderDeletePatch(previousProjectedProviderIds.hermes ?? []),
				);
			}
		}

		const channels = hostedChannelProjection(manifest);
		if (channels && name === "openclaw") JSON.stringify(openClawManagedChannelsPatch(channels));
		if (channels && name === "hermes" && runtime.enabled) {
			hermesConfig = renderHermesChannelConfig(
				hermesConfig,
				hermesManagedChannelsPatch(channels, manifest.projection?.channelCredentials),
			);
		}
	}
	validateHostedMcpProjectionPlan(manifest, paths, observations);
	validateHostedChannelCredentialsPlan(manifest, secretValues, home);
}

export function runtimeInstallerMutationTargets(
	manifest: RuntimeManifest,
	home: string,
	observations: ReadonlyMap<string, Pick<RuntimeInstallObservation, "status">>,
	options: { includeOAuthRefresh?: boolean } = {},
): string[] {
	const targets = new Set<string>();
	const openclawObservation = observations.get("openclaw");
	if (
		manifest.runtimes.openclaw?.enabled &&
		manifest.runtimes.openclaw.install &&
		(openclawObservation?.status !== "present" ||
			(options.includeOAuthRefresh !== false && hostedRuntimeOAuthDeclared(manifest, "openclaw")))
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
			join(home, ".local", "bin", "hermes"),
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

function runtimeColdInstallMutationPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
): { snapshot: RuntimeManagedMutationPlan; runtimeUserOwnershipTargets: string[] } | null {
	const pending = Object.entries(manifest.runtimes).some(([name, runtime]) => {
		if (!runtime.enabled || !runtime.install) return false;
		return observations.get(name)?.status !== "present";
	});
	if (!pending) return null;
	const home = hostedRuntimeProjectionHome(manifest, paths);
	const runtimeUserTargets = runtimeInstallerMutationTargets(manifest, home, observations, {
		includeOAuthRefresh: false,
	}).sort();
	if (runtimeUserTargets.length === 0) return null;
	const runtimeUserTrustedRoots = [paths.userHome, paths.clawdiHome];
	const metadataTargets = [
		...new Set([
			paths.userHome,
			paths.clawdiHome,
			...mutationAncestorMetadataTargets(runtimeUserTargets, runtimeUserTrustedRoots),
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
		runtimeUserOwnershipTargets: [...new Set([...metadataTargets, ...runtimeUserTargets])].sort(
			(left, right) => left.length - right.length || left.localeCompare(right),
		),
	};
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
	if (hermesAuthDir && readManagedWhatsAppAuthMarker(hermesAuthDir)) targets.add(hermesAuthDir);
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
): string[] {
	const home = hostedRuntimeProjectionHome(manifest, paths);
	const installerTargets = runtimeInstallerMutationTargets(manifest, home, observations);
	const hermesAppRoot = join(home, ".hermes", "hermes-agent");
	const openClawDatabase = join(openClawAgentDir(home), "openclaw-agent.sqlite");
	const managedWhatsAppRuntime = managedWhatsAppCompatibilityRuntime(manifest);
	const channels = hostedChannelProjection(manifest);
	const channelPluginTargets = channels
		? Object.keys(channels)
				.filter((channel) => Boolean(OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS[channel]))
				.map((channel) => join(home, ".openclaw", "extensions", channel))
		: [];
	const targets = new Set<string>([
		join(home, ".openclaw", "openclaw.json"),
		join(home, ".hermes", "config.yaml"),
		join(home, ".hermes", "SOUL.md"),
		hermesAuthPath(home),
		join(dirname(hermesAuthPath(home)), "auth.lock"),
		openClawDatabase,
		`${openClawDatabase}-wal`,
		`${openClawDatabase}-shm`,
		join(hostedCodexHome(home), CODEX_MANAGED_PROVIDER_CONFIG_FILE),
		legacyHermesModelProviderPluginDir(home),
		...installerTargets,
		...hostedChannelCredentialMutationTargets(manifest, home),
		...channelPluginTargets,
	]);
	if (openClawWorkspaceRoot) targets.add(join(openClawWorkspaceRoot, "SOUL.md"));
	if (
		hostedCodexManagedProvider(manifest) ||
		manifest.projection?.sourceSchemaVersion === "clawdi.hosted-runtime.manifest.v1"
	) {
		targets.add(paths.codexInstallRoot);
		targets.add(paths.codexCommand);
	}
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
	if (
		manifest.runtimes.hermes?.enabled &&
		manifest.runtimes.hermes.services?.dashboard &&
		!installerTargets.includes(hermesAppRoot)
	) {
		targets.add(join(hermesAppRoot, "hermes_cli", "web_dist"));
	}
	for (const agentType of MANAGED_LIVE_SYNC_AGENTS) {
		targets.add(join(paths.localEnvironments, `${agentType}.json`));
	}
	for (const runtime of HOSTED_RUNTIME_TARGETS) {
		for (const skillId of hostedBundledSkillIds()) {
			const target = hostedBundledSkillTargetDir(
				runtime,
				skillId,
				home,
				openClawWorkspaceRoot ?? undefined,
			);
			if (target) targets.add(target);
		}
	}
	const hermesSkillsRoot = join(home, ".hermes", "skills");
	const openClawSkillsRoot = openClawWorkspaceRoot ? join(openClawWorkspaceRoot, "skills") : null;
	let managesHermesSourcedSkill = false;
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		if (!("source" in desired)) continue;
		if (manifest.runtimes.hermes?.enabled === true) {
			managesHermesSourcedSkill = true;
			targets.add(join(hermesSkillsRoot, skillId));
		}
		if (manifest.runtimes.openclaw?.enabled === true && openClawSkillsRoot)
			targets.add(join(openClawSkillsRoot, skillId));
	}
	for (const reservation of managedSkillReservations("hosted-manifest")) {
		if (
			dirname(reservation.targetDir) === hermesSkillsRoot &&
			!hostedBundledSkillIds().includes(reservation.id)
		) {
			managesHermesSourcedSkill = true;
			targets.add(reservation.targetDir);
		}
		if (
			openClawSkillsRoot &&
			dirname(reservation.targetDir) === openClawSkillsRoot &&
			!hostedBundledSkillIds().includes(reservation.id)
		)
			targets.add(reservation.targetDir);
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
	programs: RuntimeSystemdUserProgram[];
	observations: ReadonlyMap<string, RuntimeInstallObservation>;
}): {
	snapshot: RuntimeManagedMutationPlan;
	runtimeUserOwnershipTargets: string[];
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
	const runtimeUserOwnershipTargets = [
		...new Set([...runtimeUserTargets, ...runtimeUserMetadataTargets, ...runtimeCommandTargets]),
	].sort((left, right) => left.length - right.length || left.localeCompare(right));
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
		runtimeUserOwnershipTargets,
		staleOfficialUnits: systemd.staleOfficialUnits,
		systemdUserUnits: systemd.unitNames,
		systemdDriftErrors: systemd.driftErrors,
	};
}

function ensureRuntimeUserOwnershipBoundaries(targets: readonly string[]): void {
	if (!runningAsRoot()) return;
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (!runtimeUser || runtimeUser === "root" || runtimeUser === "0") return;
	const uid = runtimeUserUid(runtimeUser);
	const gid = runtimeUserGid(runtimeUser);
	if (uid === 0 || gid === 0) {
		throw new Error(`runtime user ${runtimeUser} resolved to a root filesystem identity`);
	}
	for (const path of targets) {
		let node: ReturnType<typeof lstatSync>;
		try {
			node = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (node.uid === uid && node.gid === gid) continue;
		if (node.isSymbolicLink()) lchownSync(path, uid, gid);
		else chownSync(path, uid, gid);
	}
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
		hostedHermesSkillExactSourceDriver?: HostedHermesSkillExactSourceDriver;
		hostedOpenClawSkillDriver?: HostedOpenClawSkillDriver;
		hostedRuntimeContract?: HostedRuntimeContractOptions;
	} = {},
): RuntimeConvergenceResult {
	const { manifest } = load;
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
	removeHostedCliPathExposure(paths);
	removeLegacyTenantClawdiState(paths);
	if (manifest.companions?.filebrowser) {
		if (manifest.projection?.sourceBundleVersion !== "clawdi.hosted-runtime.bundle.v2") {
			throw new Error("Files companion requires a hosted v2 bundle");
		}
		if (!opts.systemdApply) {
			throw new Error("Files companion requires systemd apply and readiness hooks");
		}
	}
	const projectionHome = hostedRuntimeProjectionHome(manifest, paths);
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
	const instanceRoot = join(paths.instanceRoot, manifest.instanceId);
	const semRoot = join(instanceRoot, "sem");
	const instanceSemaphores: string[] = [];
	const installInventory: string[] = [];
	const projections: string[] = [];
	const managedLocaleFiles: string[] = [];
	const runConfigs: string[] = [];
	const runtimeSystemdUserPrograms: RuntimeSystemdUserProgram[] = [];
	const installErrors: string[] = [];
	const appliedState = readRuntimeAppliedState(paths);
	let previousInstallReceipts: RuntimeInstallReceipts | null = null;
	const installReceiptTargets: RuntimeInstallReceiptTargets = {
		officialServices: new Map(),
		channelPlugins: new Map(),
		companions: new Map(),
	};
	const previousProjectedProviderIds = appliedState?.projectedProviderIds ?? {};
	const projectedProviderIds: Record<string, string[]> = {};
	const runtimeEntries = Object.entries(manifest.runtimes).sort(([a], [b]) => a.localeCompare(b));
	const observations = new Map<string, RuntimeInstallObservation>();

	const preparedHostedSourcedSkills = opts.preparedHostedSourcedSkills ?? new Map();
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
			projectedProviderIds: Object.fromEntries(
				Object.entries(previousProjectedProviderIds).map(([runtime, providerIds]) => [
					runtime,
					[...providerIds],
				]),
			),
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
			projectedProviderIds: Object.fromEntries(
				Object.entries(previousProjectedProviderIds).map(([runtime, providerIds]) => [
					runtime,
					[...providerIds],
				]),
			),
		});
	}

	const coldInstallPlan = runtimeColdInstallMutationPlan(manifest, paths, observations);
	const coldInstallSnapshot = coldInstallPlan
		? captureRuntimeLiveSnapshot(coldInstallPlan.snapshot)
		: null;
	try {
		if (coldInstallPlan) {
			hostedRuntimeContract.assertPlatformRoots();
			ensureRuntimeUserOwnershipBoundaries(coldInstallPlan.runtimeUserOwnershipTargets);
		}
		observations.clear();
		for (const [name, runtime] of runtimeEntries) {
			const observation = observeRuntimeInstall(name, runtime, projectionHome);
			observations.set(name, observation);
			if (observation.error) installErrors.push(observation.error);
		}
		if (installErrors.length > 0) throw new Error(installErrors.join("; "));
	} catch (error) {
		if (coldInstallSnapshot) {
			try {
				restoreRuntimeLiveSnapshot(coldInstallSnapshot);
			} catch (rollbackError) {
				installErrors.push(
					`runtime installer rollback failed: ${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
		}
		const message = error instanceof Error ? error.message : String(error);
		if (installErrors.length === 0) installErrors.push(message);
		return runtimeConvergenceWithoutApply({
			load,
			paths,
			workspaceRoot,
			enabledRuntimes,
			installErrors,
			projectedProviderIds: Object.fromEntries(
				Object.entries(previousProjectedProviderIds).map(([runtime, providerIds]) => [
					runtime,
					[...providerIds],
				]),
			),
		});
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
			? openClawSkillDriver.resolveWorkspace({ home: projectionHome })
			: null;
		recoverHostedSourcedSkillReservations(
			manifest,
			projectionHome,
			preparedHostedSourcedSkills,
			hermesSkillNativeReconciler,
		);
		if (openClawWorkspaceRoot) {
			recoverHostedOpenClawBundledSkillReservations(
				manifest,
				openClawWorkspaceRoot,
				openClawSkillDriver,
			);
			recoverHostedOpenClawSourcedSkillReservations(
				manifest,
				openClawWorkspaceRoot,
				preparedHostedSourcedSkills,
				openClawSkillDriver,
			);
		}
		validateRuntimeManifestPlan(
			manifest,
			paths,
			openClawWorkspaceRoot,
			preparedHostedSourcedSkills,
		);
		validateRuntimeProjectionPlan({
			manifest,
			paths,
			openClawWorkspaceRoot,
			secretValues,
			observations,
			previousProjectedProviderIds,
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
			programs: plannedRuntimePrograms,
			observations,
		});
	} catch (error) {
		if (coldInstallSnapshot) restoreRuntimeLiveSnapshot(coldInstallSnapshot);
		throw error;
	}
	if (mutationPlan.systemdDriftErrors.length > 0) {
		if (coldInstallSnapshot) restoreRuntimeLiveSnapshot(coldInstallSnapshot);
		installErrors.push(...mutationPlan.systemdDriftErrors);
		return runtimeConvergenceWithoutApply({
			load,
			paths,
			workspaceRoot,
			enabledRuntimes,
			installErrors,
			projectedProviderIds: Object.fromEntries(
				Object.entries(previousProjectedProviderIds).map(([runtime, providerIds]) => [
					runtime,
					[...providerIds],
				]),
			),
		});
	}
	const workspaceExistedBeforeApply = existsSync(workspaceRoot);
	let liveSnapshot: ReturnType<typeof captureRuntimeLiveSnapshot>;
	try {
		liveSnapshot = captureRuntimeLiveSnapshot(mutationPlan.snapshot);
		if (coldInstallSnapshot) {
			for (const [path, node] of coldInstallSnapshot.entries) {
				liveSnapshot.entries.set(path, node);
			}
		}
	} catch (error) {
		if (coldInstallSnapshot) restoreRuntimeLiveSnapshot(coldInstallSnapshot);
		throw error;
	}
	let systemdActivationApplied = false;
	let systemdActivationAttempted = false;
	let restartDaemon = false;
	let desiredDaemonAuthTokenRevision: string | undefined;
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
		ensureRuntimeUserOwnershipBoundaries(mutationPlan.runtimeUserOwnershipTargets);
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
				observations.set(
					"openclaw",
					ensureHostedOpenClawProviderAuthCapability({
						manifest,
						secretValues,
						observation: openClawObservation,
						home: projectionHome,
					}),
				);
			} catch (error) {
				installErrors.push(
					`runtime openclaw OAuth capability check failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		if (installErrors.length > 0) throw new Error(installErrors.join("; "));
		if (
			openClawWorkspaceRoot &&
			resolve(openClawSkillDriver.resolveWorkspace({ home: projectionHome })) !==
				resolve(openClawWorkspaceRoot)
		) {
			throw new Error("OpenClaw official agent workspace changed during runtime reconciliation");
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
					`runtime codex add-on install failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
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
			if (managedWhatsAppRuntime && compatibility.status === "rollback-refused") {
				throw new Error(compatibility.errors.join(", "));
			}
		} catch (error) {
			if (managedWhatsAppRuntime) {
				installErrors.push(
					`runtime ${managedWhatsAppRuntime} managed WhatsApp compatibility failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		if (installErrors.length > 0) throw new Error(installErrors.join("; "));

		hostedRuntimeContract.assertPlatformRoots();
		ensureRuntimeUserHome(paths.userHome);
		ensureRuntimeUserCliStateRoot(paths.clawdiHome, hostedRuntimeContract.identity);
		withRuntimeUserFileAccess(() => {
			mkdirSync(workspaceRoot, { recursive: true });
			makeRuntimeUserOwned(workspaceRoot);
		});
		for (const directory of [paths.installInventory, paths.projectionRoot, instanceRoot, semRoot]) {
			ensureRuntimePlatformDirectory(paths, directory, { mode: 0o755 });
		}
		ensureRuntimePlatformDirectory(paths, paths.managedSecretRoot);
		makeManagedSecretRoot(paths.managedSecretRoot);
		ensureRuntimePlatformDirectory(paths, paths.egressRoot, { mode: 0o711 });
		chmodSync(paths.egressRoot, 0o711);
		makeEgressIdentityPrivateDir(paths.egressCaDir);
		ensureRuntimePlatformDirectory(paths, dirname(paths.egressSystemCaFile), { mode: 0o711 });
		chmodSync(dirname(paths.egressSystemCaFile), 0o711);
		makeRuntimeUserPrivateDir(paths.egressScratchRoot, paths.userHome);

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
			restartDaemon = desiredDaemonAuthTokenRevision !== appliedState?.daemonAuthTokenRevision;
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
		for (const name of HOSTED_RUNTIME_TARGETS) {
			try {
				applyHostedBundledSkills(
					name,
					observations.get(name),
					manifest,
					projectionHome,
					openClawWorkspaceRoot,
					openClawSkillDriver,
				);
			} catch (error) {
				installErrors.push(
					`runtime ${name} skill projection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		try {
			applyHostedSourcedSkills(
				observations.get("hermes"),
				manifest,
				projectionHome,
				preparedHostedSourcedSkills,
				hermesSkillNativeReconciler,
			);
		} catch (error) {
			installErrors.push(
				`runtime hermes sourced Skill projection failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		if (openClawWorkspaceRoot) {
			try {
				applyHostedOpenClawSourcedSkills(
					observations.get("openclaw"),
					manifest,
					projectionHome,
					openClawWorkspaceRoot,
					preparedHostedSourcedSkills,
					openClawSkillDriver,
				);
			} catch (error) {
				installErrors.push(
					`runtime openclaw sourced Skill delivery failed: ${error instanceof Error ? error.message : String(error)}`,
				);
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
						observation,
						manifest,
						secretValues,
						paths,
						home: projectionHome,
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
				const localeFile = withRuntimeUserFileAccess(() =>
					applyHostedLocaleProjection(name, manifest, projectionHome, openClawWorkspaceRoot),
				);
				if (localeFile) managedLocaleFiles.push(localeFile);
			} catch (error) {
				installErrors.push(
					`runtime ${name} locale projection failed: ${
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
					workspaceRoot,
					previousProjectedProviderIds[name] ?? [],
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
				applyHostedChannelProjection(name, observation, manifest, projectionHome, workspaceRoot);
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

			const semaphorePath = join(semRoot, `${name}.enabled`);
			if (runtime.enabled) {
				writeRuntimePrivateFileAtomic(paths, semaphorePath, `${generatedAt}\n`);
				instanceSemaphores.push(semaphorePath);
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
			runtimeRevision: runtimeProgramRevisionForManifest,
			commonEnvironment: commonSystemdEnvironment,
		});
		staleSystemdFiles = systemdUnits.staleFiles;
		const officialServicePlan = planOfficialRuntimeServices(
			runtimeSystemdUserPrograms,
			paths,
			previousInstallReceipts,
			opts.systemdApply !== undefined || opts.executeOfficialServiceInstallers === true,
		);
		installReceiptTargets.officialServices = officialServicePlan.targets;
		const hermesDashboardArtifactPlan = planHermesDashboardArtifact(
			runtimeSystemdUserPrograms,
			paths,
			previousInstallReceipts,
			opts.systemdApply !== undefined || opts.executeOfficialServiceInstallers === true,
		);
		if (hermesDashboardArtifactPlan.receiptKey && hermesDashboardArtifactPlan.target) {
			installReceiptTargets.officialServices.set(
				hermesDashboardArtifactPlan.receiptKey,
				hermesDashboardArtifactPlan.target,
			);
		}
		if (
			(officialServicePlan.pending.length > 0 ||
				(hermesDashboardArtifactPlan.program !== null &&
					hermesDashboardArtifactPlan.target?.expectedCurrentRevision === null)) &&
			systemdUnits.egressSidecarActive &&
			opts.systemdApply
		) {
			systemdActivationAttempted = true;
			const prerequisite = opts.systemdApply.activateEgressPrerequisite({
				restartDaemon,
				restartEgressSidecar,
				stopEgressSidecar: false,
				reconcileUserUnits: mutationPlan.systemdUserUnits,
				staleSystemUnits: [],
				staleUserUnits: [],
			});
			if (!prerequisite.applied) {
				throw new Error("transparent-egress system prerequisites did not reach readiness");
			}
		}

		for (const item of officialServicePlan.pending) {
			hostedRuntimeContract.assertPlatformRoots();
			const error = installOfficialRuntimeService(item, paths);
			if (error) throw new Error(error);
		}
		const artifactError = prepareHermesDashboardArtifact(
			hermesDashboardArtifactPlan,
			paths,
			systemdUnits.egressSidecarActive ? egressSystemdProgram?.systemCaBundle : undefined,
		);
		if (artifactError) throw new Error(artifactError);

		hostedRuntimeContract.assertPlatformRoots();
		const bootFinished = join(instanceRoot, "boot-finished");
		writeRuntimePrivateFileAtomic(paths, bootFinished, `${generatedAt}\n`);
		if (opts.systemdApply) {
			systemdActivationAttempted = true;
			const activation = opts.systemdApply.activate({
				restartDaemon,
				restartEgressSidecar,
				stopEgressSidecar: false,
				reconcileUserUnits: mutationPlan.systemdUserUnits,
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
			projectedProviderIds,
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
				instanceSemaphores,
				bootFinished,
			},
		};
		if (installErrors.length === 0) {
			hostedRuntimeContract.assertPlatformRoots();
			const daemonRevisionPreviouslyCommitted =
				desiredDaemonAuthTokenRevision !== undefined &&
				desiredDaemonAuthTokenRevision === appliedState?.daemonAuthTokenRevision;
			const egressRevisionPreviouslyCommitted =
				desiredEgressSidecarSecretRevision !== undefined &&
				desiredEgressSidecarSecretRevision === appliedState?.egressSidecarSecretRevision;
			commitRuntimeInstallReceipts(installReceiptTargets, paths);
			opts.commitAuthority?.(convergence, {
				...(desiredDaemonAuthTokenRevision !== undefined &&
				(systemdActivationApplied || daemonRevisionPreviouslyCommitted)
					? { daemonAuthTokenRevision: desiredDaemonAuthTokenRevision }
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
		const applyError = error instanceof Error ? error.message : String(error);
		let candidateQuiesced = !systemdActivationAttempted;
		if (systemdActivationAttempted) {
			try {
				opts.systemdApply?.quiesce();
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
			try {
				hostedRuntimeContract.assertPlatformRoots();
				restoreRuntimeLiveSnapshot(liveSnapshot);
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
				filesystemRollbackSucceeded = true;
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
		if (opts.systemdApply && filesystemRollbackSucceeded) {
			try {
				opts.systemdApply.rollback({
					restartDaemon,
					restartEgressSidecar: restartEgressSidecar && egressRollbackAuthorityVerified,
					stopEgressSidecar: restartEgressSidecar && !egressRollbackAuthorityVerified,
					reconcileUserUnits: mutationPlan.systemdUserUnits,
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
		} else if (opts.systemdApply && candidateQuiesced) {
			installErrors.push(
				"runtime systemd rollback skipped because filesystem authority restoration failed",
			);
		} else if (opts.systemdApply) {
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
			projectedProviderIds: Object.fromEntries(
				Object.entries(previousProjectedProviderIds).map(([runtime, providerIds]) => [
					runtime,
					[...providerIds],
				]),
			),
		});
	}
}
