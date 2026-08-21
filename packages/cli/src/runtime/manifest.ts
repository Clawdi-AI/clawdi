import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { buildAgentTargetProjection } from "../lib/ai-provider-projection";
import { resolveCurrentCliResourceRoot } from "../lib/current-cli-invocation";
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
	getHermesRawConfigValue,
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
import { managedMcpHeaderPlaceholder } from "./hosted-egress-profiles";
import {
	type HostedHermesSkillExactSourceDriver,
	hostedHermesSkillExactSourceDriver,
} from "./hosted-hermes-skill";
import { createOpenClawHostedContext, type OpenClawHostedContext } from "./hosted-openclaw-context";
import { type HostedOpenClawSkillDriver, hostedOpenClawSkillDriver } from "./hosted-openclaw-skill";
import {
	agentTargetProjectionInput,
	hostedAiProviderCatalog,
	hostedProviderEnvironment,
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
	type RuntimeInstallReceipts,
	readRuntimeInstallReceipts,
	runtimeInstallReceiptsPath,
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
	type LiveSyncAgent,
	type RuntimeManifest,
} from "./manifest-contract";
import {
	commitRuntimeInstallReceipts,
	observeRuntimeInstall,
	planRuntimeInstallObservation,
	type RuntimeInstallObservation,
	type RuntimeInstallReceiptTarget,
	type RuntimeInstallReceiptTargets,
	runtimeAppRoot,
	runtimeColdInstallMutationPlan,
	runtimeCommandCurrentRevision,
	runtimeCommandPath,
	runtimeFileCurrentRevision,
	runtimeInstallerMutationTargets,
	verifiedReceiptCurrentRevision,
} from "./manifest-install";
import {
	discoverOpenClawManagedProviderAuthAgentDirs,
	ensureHostedOpenClawProviderAuthCapability,
	hermesAuthPath,
	openClawSupportsOwnerBrowserBootstrap,
	reconcileHostedRuntimeOAuthCredentials,
} from "./manifest-oauth";
import {
	applyHostedAiProviderProjection,
	applyHostedCodexManagedProviderProjection,
	assertHostedProviderProjectionMode,
	buildOpenClawHostedProviderPatch,
	CODEX_MANAGED_PROVIDER_CONFIG_FILE,
	ensureHostedCodexCli,
	hostedCodexHome,
	hostedCodexManagedConfigToml,
	hostedCodexManagedProvider,
	legacyHermesModelProviderPluginDir,
	openClawConfigPatchIsApplied,
	openClawGatewayHostedPatch,
	previewHostedAiProviderProjectionRevision,
	writeProviderHealthStatus,
} from "./manifest-providers";
import {
	type HostedMcpServerDesiredState,
	type HostedSkillSource,
	hostedMcpDesiredStateSchema,
} from "./manifest-resources";
import {
	applyHostedRuntimeConfigProjection,
	hermesConfigContext,
	liveSyncEnvironmentIndexSchema,
	managedLocaleBlock,
	mergeRuntimeSecretEnv,
	nextManagedLocaleFileContent,
	projectionPayload,
	resolvedRuntimeServiceSettings,
	resolvedRuntimeSettings,
} from "./manifest-runtime-config";
import {
	canonicalJsonEqual,
	isPlainRecord,
	mutationAncestorMetadataTargets,
	type RuntimeConvergenceResult,
	type RuntimePrivateAppliedAuthority,
	type RuntimeSystemdApplyHooks,
	recordValue,
	stringValue,
	writeJsonFile,
	writeRuntimePrivateFileAtomic,
} from "./manifest-shared";
import { ensureManagedOpenClawProviderPlugin } from "./openclaw-managed-provider-plugin";
import { openClawPluginInspectSchema } from "./openclaw-plugin-observation";
import { normalizeSecretValues, runtimeSecretValue } from "./secret-values";

export type { RuntimeInstall, RuntimeManifest } from "./manifest-contract";
export { runtimeInstallerMutationTargets } from "./manifest-install";
export type { OpenClawHostedProviderPatch } from "./manifest-providers";
export { buildOpenClawHostedProviderPatch } from "./manifest-providers";
export {
	loadRuntimeManifest,
	type RuntimeManifestFailure,
	type RuntimeManifestLoad,
} from "./manifest-source";

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
	runtimeNameSchema,
	runtimeRunConfigId,
	runtimeServiceNameSchema,
	writeRuntimeRunConfig,
} from "./run-config";
import { daemonProgramRevision, runtimeProgramRevision } from "./runtime-impact-revision";
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
import { ensureRuntimePlatformDirectory } from "./state";

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

// SUNSET: Remove after every fleet host has migrated to native Hermes provider projection.

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

export type { RuntimeConvergenceResult, RuntimePrivateAppliedAuthority } from "./manifest-shared";

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
