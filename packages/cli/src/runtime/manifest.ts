import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	chownSync,
	constants,
	existsSync,
	lchownSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AiProviderApiMode,
	AiProviderAuth,
	AiProviderCatalog,
	AiProviderModel,
	AiProviderType,
} from "@clawdi/shared";
import {
	CLAWDI_MANAGED_PROVIDER_ID,
	CLAWDI_MANAGED_V1_PROVIDER_ID,
	isAiProviderApiMode,
	isAiProviderType,
	isClawdiManagedV2ProviderId,
} from "@clawdi/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { agentSkillTargetDir } from "../adapters/registry";
import { type AgentPrimaryModel, buildAgentTargetProjection } from "../lib/ai-provider-projection";
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
import { writePrivateFileAtomic } from "../lib/private-file";
import { readRuntimeAppliedState, runtimeContentSha256 } from "./applied-state";
import {
	type RuntimeApplyContext,
	runtimeApplyContextServiceEnvironment,
	runtimeApplyIdentityServiceEnvironment,
} from "./apply-identity";
import {
	ensureRuntimeAuthTokenFile,
	RUNTIME_AUTH_TOKEN_SECRET_REF,
	readRuntimeAuthToken,
} from "./auth-token";
import {
	adoptableLegacyHostedBundledSkill,
	assertHostedBundledSkillCatalogDigest,
	hostedBundledSkillIds,
	loadHostedBundledSkill,
	reconcileHostedBundledSkill,
	resolveHostedBundledSkill,
} from "./hosted-bundled-skill";

export { withRuntimeConvergeLock, withRuntimeConvergeLockAsync } from "./converge-lock";

import {
	isClawdiManagedProviderProjection,
	managedMcpHeaderPlaceholder,
	normalizeSecretRef,
} from "./hosted-egress-profiles";
import {
	emptyRuntimeInstallReceipts,
	type RuntimeInstallReceiptEntry,
	type RuntimeInstallReceipts,
	readRuntimeInstallReceipts,
	writeRuntimeInstallReceipts,
} from "./install-receipts";
import { captureRuntimeLiveSnapshot, restoreRuntimeLiveSnapshot } from "./live-state-snapshot";
import {
	buildManagedModelsEndpoint,
	extractManagedLiveModels,
	resolveManagedPrimaryModel,
} from "./managed-model-resolution";
import {
	installReservedManagedSkill,
	managedSkillReservationOwner,
	releaseManagedSkill,
	reserveManagedSkill,
} from "./managed-skill-reservation";
import type { LiveSyncAgent, RuntimeInstall, RuntimeManifest } from "./manifest-contract";
import {
	type HostedMcpServerDesiredState,
	hostedMcpDesiredStateSchema,
	hostedMcpServerDesiredStateSchema,
} from "./manifest-resources";
import {
	isEnvSecretRef,
	normalizeSecretValues,
	projectedRuntimeEnvironment,
	type RuntimeEnvironmentAuthority,
	runtimeSecretValue as resolveRuntimeSecretValue,
} from "./secret-values";

export type { RuntimeInstall, RuntimeManifest } from "./manifest-contract";
export {
	loadRuntimeManifest,
	type RuntimeManifestFailure,
	type RuntimeManifestLoad,
	runtimeManifestFixturePath,
} from "./manifest-source";

import { withEffectiveFilesystemIdentity } from "./effective-identity";
import {
	applyEgressTransparentRuntimeEnv,
	MANAGED_EGRESS_PLACEHOLDER_VALUE,
	SYSTEM_CA_BUNDLE,
} from "./egress-env";
import {
	buildEgressProfileBundle,
	egressProfileSecretRefs,
	hasEnabledEgressProfiles,
	writeEgressProfileBundle,
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
import type { RuntimePaths } from "./paths";
import { detectRuntimeMode } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import {
	buildRuntimeRunConfig,
	isSupportedRuntimeName,
	type RuntimeName,
	type RuntimeRunConfig,
	type RuntimeRunSettings,
	type RuntimeServiceName,
	runtimeManagedBinDir,
	runtimeNameSchema,
	runtimeRunConfigId,
	runtimeServiceNameSchema,
	withoutPathEntry,
	writeRuntimeRunConfig,
} from "./run-config";
import { createRuntimeSecretResolver, type RuntimeSecretResolver } from "./runtime-secret-resolver";
import {
	GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
	isGeneratedRuntimeSystemdFile,
} from "./systemd-user";
import {
	parsePositiveLinuxId,
	TRANSPARENT_EGRESS_TABLE,
	TRANSPARENT_EGRESS_TRANSPORT_VERSION,
} from "./transparent-egress";
import { WHATSAPP_UPSTREAM_READY } from "./whatsapp-gate";

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
}

interface RuntimeSystemdApplyHooks {
	activateEgressPrerequisite: (signal: RuntimeSystemdApplySignal) => RuntimeSystemdApplyResult;
	activate: (signal: RuntimeSystemdApplySignal) => RuntimeSystemdApplyResult;
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

interface RuntimeInstallReceiptTarget {
	desiredRevision: string;
	currentRevision: () => string | null;
	expectedCurrentRevision: string | null;
}

interface RuntimeInstallReceiptTargets {
	officialServices: Map<string, RuntimeInstallReceiptTarget>;
	channelPlugins: Map<string, RuntimeInstallReceiptTarget>;
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

function writeJsonFile(path: string, payload: unknown): void {
	writePrivateFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
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
	writeJsonFile(paths.manifestLastGood, manifest);
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
	writePrivateFileAtomic(
		paths.managedSecretCacheFile,
		`${JSON.stringify(recoverable, null, 2)}\n`,
		{
			mode: 0o600,
			dirMode: 0o755,
		},
	);
	makeRootOwned(dirname(paths.managedSecretCacheFile));
	makeRootOwned(paths.managedSecretCacheFile);
}

function makeManagedSecretRoot(path: string): void {
	makeRootOwned(path);
	try {
		chmodSync(path, 0o711);
	} catch {
		// Best effort for non-POSIX local development environments.
	}
}

function writeSecretValues(
	secretValues: Record<string, string> | undefined,
	paths: RuntimePaths,
	excludedRefs: readonly string[] = [],
): string | null {
	const path = paths.managedSecretFile;
	const normalized = omitSecretRefs(secretValues, excludedRefs);
	if (Object.keys(normalized).length === 0) {
		rmSync(path, { force: true });
		return null;
	}
	writePrivateFileAtomic(path, `${JSON.stringify(normalized, null, 2)}\n`, {
		mode: 0o600,
		dirMode: 0o700,
	});
	makeManagedSecretRoot(dirname(path));
	makeRootOwned(path);
	return path;
}

function omitSecretRefs(
	secretValues: Record<string, string> | undefined,
	excludedRefs: readonly string[],
): Record<string, string> {
	const normalized = normalizeSecretValues(secretValues);
	for (const ref of excludedRefs) {
		for (const alias of secretRefAliases(ref)) {
			delete normalized[alias];
		}
	}
	return normalized;
}

function secretRefAliases(ref: string): string[] {
	const aliases = new Set<string>([ref]);
	const normalized = normalizeSecretRef(ref);
	if (normalized) aliases.add(normalized);
	if (ref.startsWith("secret://")) aliases.add(ref.slice("secret://".length));
	return [...aliases];
}

interface ManagedWhatsAppAuthCredential {
	accountKey: string;
	credentialId: string;
	authDir: string;
	credsJsonSecretRef: string;
	target: "openclaw" | "hermes" | "legacy";
}

const MANAGED_WHATSAPP_AUTH_MARKER = ".clawdi-managed-whatsapp-auth.json";
const MANAGED_WHATSAPP_AUTH_ROOT = [".openclaw", "credentials", "whatsapp"] as const;
const MANAGED_HERMES_WHATSAPP_AUTH_ROOT = [".hermes", "platforms", "whatsapp"] as const;

function materializeHostedChannelCredentials(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
	home: string,
): void {
	if (!hostedChannelCredentialsDeclared(manifest)) return;
	if (!WHATSAPP_UPSTREAM_READY) {
		removeStaleManagedWhatsAppAuthDirs(home, new Set());
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
		const credsJson = resolveRuntimeSecretValue(
			normalizedSecrets,
			credential.credsJsonSecretRef,
			runtimeEnvironment,
		);
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
	runtimeEnvironment: RuntimeEnvironmentAuthority,
	home: string,
): void {
	if (!hostedChannelCredentialsDeclared(manifest) || !WHATSAPP_UPSTREAM_READY) return;
	const normalizedSecrets = normalizeSecretValues(secretValues);
	for (const credential of hostedWhatsAppAuthCredentials(manifest)) {
		const authDirError = managedWhatsAppAuthDirError(home, credential);
		if (authDirError) throw new Error(authDirError);
		const credsJson = resolveRuntimeSecretValue(
			normalizedSecrets,
			credential.credsJsonSecretRef,
			runtimeEnvironment,
		);
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
		if (!recordValue(parsed)) {
			throw new Error(
				`invalid WhatsApp auth state JSON for ${credential.accountKey}/${credential.credentialId}: creds.json must be a JSON object`,
			);
		}
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
	const openclawAuthDir = openclawTarget
		? stringValue(openclawTarget.authDir)
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
	const hermesSessionDir = hermesTarget
		? (stringValue(hermesTarget.sessionDir) ?? stringValue(hermesTarget.authDir))
		: null;
	if (hermesSessionDir) {
		parsedTargets.push({
			accountKey,
			credentialId,
			authDir: hermesSessionDir,
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
	let parsedCreds: unknown;
	try {
		parsedCreds = JSON.parse(credsJson);
		if (!recordValue(parsedCreds)) {
			throw new Error("creds.json must be a JSON object");
		}
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

function managedWhatsAppAuthDirError(
	home: string,
	credential: ManagedWhatsAppAuthCredential,
): string | null {
	const roots = managedWhatsAppAuthRootsForCredential(home, credential);
	if (roots.length === 0) return "WhatsApp auth credential projection is missing runtime home";
	const resolvedAuthDir = resolve(credential.authDir);
	for (const root of roots) {
		const relativePath = relative(root, resolvedAuthDir);
		if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
			return null;
		}
	}
	return `WhatsApp auth directory must be under ${roots.join(" or ")}`;
}

function managedWhatsAppAuthRootsForCredential(
	home: string,
	credential: ManagedWhatsAppAuthCredential,
): string[] {
	const roots = managedWhatsAppAuthRoots(home);
	if (credential.target === "hermes") {
		return roots.hermes ? [roots.hermes] : [];
	}
	if (credential.target === "openclaw" || credential.target === "legacy") {
		return roots.openclaw ? [roots.openclaw] : [];
	}
	return [roots.openclaw, roots.hermes].filter((root): root is string => Boolean(root));
}

function managedWhatsAppAuthRoots(home: string): {
	openclaw: string | null;
	hermes: string | null;
} {
	return {
		openclaw: home ? resolve(home, ...MANAGED_WHATSAPP_AUTH_ROOT) : null,
		hermes: home ? resolve(home, ...MANAGED_HERMES_WHATSAPP_AUTH_ROOT) : null,
	};
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
	for (const root of Object.values(managedWhatsAppAuthRoots(home))) {
		if (!root || !existsSync(root)) continue;
		removeStaleManagedWhatsAppAuthDirsUnderRoot(root, expected);
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

function writeScopedSecretValues(
	path: string,
	secretValues: Record<string, string> | undefined,
	refs: readonly string[],
	paths: RuntimePaths,
	owner: "root" | "runtime-user" | "egress-identity",
	options: ScopedSecretValuesOptions = {},
): string | null {
	const scoped = scopedSecretValues(secretValues, refs, options);
	return writeResolvedSecretValues(path, scoped, paths, owner);
}

function writeResolvedSecretValues(
	path: string,
	resolvedSecretValues: Readonly<Record<string, string>>,
	paths: RuntimePaths,
	owner: "root" | "runtime-user" | "egress-identity",
): string | null {
	if (Object.keys(resolvedSecretValues).length === 0) {
		rmSync(path, { force: true });
		return null;
	}
	writePrivateFileAtomic(path, `${JSON.stringify(resolvedSecretValues, null, 2)}\n`, {
		mode: 0o600,
		dirMode: 0o700,
	});
	if (owner === "runtime-user") {
		if (dirname(path) !== paths.managedSecretRoot) {
			makeRuntimeUserOwned(dirname(path));
		}
		makeRuntimeUserOwned(path);
	} else if (owner === "egress-identity") {
		makeRootOwned(dirname(path));
		makeEgressIdentityOwned(path);
	} else {
		makeRootOwned(dirname(path));
		makeRootOwned(path);
	}
	if (path.startsWith(paths.managedSecretRoot)) {
		makeManagedSecretRoot(paths.managedSecretRoot);
		try {
			chmodSync(path, 0o600);
		} catch {
			// Best effort for non-POSIX local development environments.
		}
	}
	return path;
}

interface ScopedSecretValuesOptions {
	resolveEnv?: boolean;
	resolver?: RuntimeSecretResolver;
	require?: (ref: string) => boolean;
}

function scopedSecretValues(
	secretValues: Record<string, string> | undefined,
	refs: readonly string[],
	options: ScopedSecretValuesOptions = {},
): Record<string, string> {
	const normalizedValues = normalizeSecretValues(secretValues);
	const scoped: Record<string, string> = {};
	for (const ref of refs) {
		if (isEnvSecretRef(ref) && !options.resolveEnv) continue;
		const value = options.resolver
			? options.resolver.resolve(ref)
			: resolveRuntimeSecretValue(normalizedValues, ref, projectedRuntimeEnvironment({}));
		if (!value) {
			if (options.require?.(ref)) throw new Error(`Runtime secret ${ref} is unavailable.`);
			continue;
		}
		scoped[ref] = value;
		const normalized = normalizeSecretRef(ref);
		if (normalized) scoped[normalized] = value;
		if (ref.startsWith("secret://")) scoped[ref.slice("secret://".length)] = value;
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
	runtimeEnvironment: RuntimeEnvironmentAuthority,
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
				: providerSecretAvailable(secretValues ?? {}, apiKeySecretRef, runtimeEnvironment);
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
	writePrivateFileAtomic(
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

function providerSecretAvailable(
	secretValues: Record<string, string>,
	ref: string,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): boolean {
	return resolveRuntimeSecretValue(secretValues, ref, runtimeEnvironment) !== null;
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

function makeRuntimeUserOwned(path: string): void {
	makeSystemUserOwned(path, process.env.CLAWDI_RUNTIME_USER?.trim() ?? "");
}

function makeEgressIdentityOwned(path: string): void {
	if (!runningAsRoot()) return;
	const uid = runtimeEgressUid();
	const gid = runtimeEgressGid();
	chownSync(path, uid, gid);
}

function makeSystemUserOwned(path: string, user: string): void {
	if (!runningAsRoot()) return;
	if (!user || user === "root") return;
	const result = spawnSync("id", ["-u", user], { encoding: "utf8" });
	const group = spawnSync("id", ["-g", user], { encoding: "utf8" });
	if (result.status !== 0 || group.status !== 0) return;
	const uid = Number.parseInt(result.stdout.trim(), 10);
	const gid = Number.parseInt(group.stdout.trim(), 10);
	if (!Number.isFinite(uid) || !Number.isFinite(gid)) return;
	try {
		chownSync(path, uid, gid);
	} catch {
		// Best effort: hosted demos without a system user still exercise the
		// manifest path, but production images provide CLAWDI_RUNTIME_USER.
	}
}

function makeRootOwned(path: string): void {
	if (!runningAsRoot()) return;
	try {
		chownSync(path, 0, 0);
	} catch {
		// Best effort for local tests and non-root development environments.
	}
}

function makeRootReadableDir(path: string): void {
	mkdirSync(path, { recursive: true });
	makeRootOwned(path);
	try {
		chmodSync(path, 0o755);
	} catch {
		// Best effort for non-POSIX local development environments.
	}
}

function publishRootOwnedToolTree(path: string): void {
	const node = lstatSync(path);
	if (node.isSymbolicLink()) {
		if (runningAsRoot()) lchownSync(path, 0, 0);
		return;
	}
	makeRootOwned(path);
	if (node.isDirectory()) {
		chmodSync(path, 0o755);
		for (const entry of readdirSync(path)) publishRootOwnedToolTree(join(path, entry));
		return;
	}
	chmodSync(path, node.mode & 0o111 ? 0o755 : 0o644);
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
	if (name === "openclaw") return join(home, ".openclaw", "bin", "openclaw");
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

function executableExists(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function commandExists(name: string): boolean {
	const path = process.env.PATH ?? "";
	for (const dir of path.split(":")) {
		if (!dir) continue;
		if (executableExists(join(dir, name))) return true;
	}
	return false;
}

function runningAsRoot(): boolean {
	return typeof process.geteuid === "function" && process.geteuid() === 0;
}

function withRuntimeUserFileAccess<T>(
	operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
	// This scope is only for synchronous filesystem operations. Runtime commands
	// must use gosu/runuser so child processes cannot retain a saved root identity.
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (!runningAsRoot() || !runtimeUser || runtimeUser === "root") return operation();
	const uid = runtimeUserUid(runtimeUser);
	const gid = runtimeUserGid(runtimeUser);
	if ((uid === 0 || gid === 0) && runtimeUser !== "0") {
		throw new Error(`runtime user ${runtimeUser} resolved to a root filesystem identity`);
	}
	return withEffectiveFilesystemIdentity(
		{
			uid,
			gid,
		},
		operation,
	);
}

function runtimeInstallerExecution(
	name: string,
	install: RuntimeInstall,
	installerPath: string,
): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	executionUser: string | null;
} {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	const env = runtimeInstallerEnv(name, install);
	if (!runningAsRoot() || !runtimeUser || runtimeUser === "root") {
		return {
			command: "bash",
			args: [installerPath, ...install.args],
			env,
			executionUser: null,
		};
	}

	const userEnv = {
		...env,
		USER: runtimeUser,
		LOGNAME: runtimeUser,
	};
	if (commandExists("gosu")) {
		return {
			command: "gosu",
			args: [runtimeUser, "bash", installerPath, ...install.args],
			env: userEnv,
			executionUser: runtimeUser,
		};
	}
	if (commandExists("runuser")) {
		return {
			command: "runuser",
			args: [
				"-u",
				runtimeUser,
				"--",
				"env",
				`HOME=${install.home}`,
				`USER=${runtimeUser}`,
				`LOGNAME=${runtimeUser}`,
				"bash",
				installerPath,
				...install.args,
			],
			env,
			executionUser: runtimeUser,
		};
	}

	throw new Error(
		`runtime init is running as root but cannot drop to CLAWDI_RUNTIME_USER=${runtimeUser}; install gosu or runuser`,
	);
}

function runtimeInstallerEnv(name: string, install: RuntimeInstall): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: install.home };
	delete env.NPM_CONFIG_PREFIX;
	delete env.npm_config_prefix;
	delete env.NPM_CONFIG_CACHE;
	delete env.npm_config_cache;
	env.SSL_CERT_FILE = SYSTEM_CA_BUNDLE;
	env.NODE_EXTRA_CA_CERTS = SYSTEM_CA_BUNDLE;
	env.REQUESTS_CA_BUNDLE = SYSTEM_CA_BUNDLE;
	env.CURL_CA_BUNDLE = SYSTEM_CA_BUNDLE;
	env.GIT_SSL_CAINFO = SYSTEM_CA_BUNDLE;
	env.NPM_CONFIG_CAFILE = SYSTEM_CA_BUNDLE;
	env.npm_config_cafile = SYSTEM_CA_BUNDLE;
	if (name === "hermes") {
		const hermesHome = join(install.home, ".hermes");
		env.HERMES_HOME = hermesHome;
		env.UV_PYTHON_INSTALL_DIR = join(hermesHome, "uv", "python");
		env.UV_PYTHON_BIN_DIR = join(hermesHome, "uv", "bin");
		env.UV_MANAGED_PYTHON = "1";
		delete env.UV_NO_MANAGED_PYTHON;
		delete env.UV_PYTHON_DOWNLOADS;
	}
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
	if (executableExists(commandPath)) {
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
		const execution = runtimeInstallerExecution(name, install, materialized.path);
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
	workspaceRoot: string,
): string | null {
	const locale = manifest.locale;
	if (runtime === "openclaw") {
		return locale
			? updateManagedLocaleFile(join(workspaceRoot, "SOUL.md"), managedLocaleBlock(locale))
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

export function hostedAiProviderCatalog(
	manifest: RuntimeManifest,
	runtimeName?: string,
	options: {
		primaryModelOverride?: AgentPrimaryModel;
		managedModelsOverride?: readonly AiProviderModel[];
	} = {},
): { catalog: AiProviderCatalog; primaryModel: AgentPrimaryModel } | null {
	const providers = manifest.projection?.providers;
	if (!providers || Object.keys(providers).length === 0) return null;
	const rawEntries = hostedProviderEntries(providers, runtimeName, manifest);
	const primaryModel =
		options.primaryModelOverride ?? hostedRuntimePrimaryModel(manifest, runtimeName);
	if (!primaryModel) return null;
	const entries = rawEntries
		.map(([id, raw]) => {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
			const input = raw as Record<string, unknown>;
			const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : undefined;
			const apiMode = hostedProviderApiMode(input);
			const apiKeySecretRef =
				typeof input.apiKeySecretRef === "string" ? input.apiKeySecretRef : undefined;
			const runtimeEnvName = hostedProviderRuntimeEnvName(id, input);
			if (hostedProviderUnhealthy(input)) return null;
			if (!baseUrl) return null;
			const auth = hostedProviderAuth(input, Boolean(apiKeySecretRef));
			if (!auth) return null;
			const models = hostedProviderModels(
				input,
				id === primaryModel.provider_id ? primaryModel : null,
				id === primaryModel.provider_id ? options.managedModelsOverride : undefined,
			);
			return {
				id,
				type: hostedProviderType(input),
				base_url: baseUrl,
				api_mode: apiMode,
				managed_by: hostedProviderManagedBy(input),
				auth,
				runtime_env_name: apiKeySecretRef || auth.type !== "none" ? runtimeEnvName : undefined,
				models,
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
	if (entries.length === 0) return null;
	return {
		catalog: {
			schema_version: 1,
			providers: entries,
			defaults: { chat_provider_id: primaryModel.provider_id },
		},
		primaryModel,
	};
}

function hostedProviderManagedBy(
	input: Record<string, unknown>,
): AiProviderCatalog["providers"][number]["managed_by"] {
	const value = input.managed_by;
	return value === "clawdi" || value === "user" ? value : undefined;
}

function hostedProviderEntries(
	providers: Record<string, unknown>,
	runtimeName?: string,
	manifest?: RuntimeManifest,
): Array<[string, unknown]> {
	if (!runtimeName) {
		return Object.entries(providers).sort(([left], [right]) => left.localeCompare(right));
	}
	const providerIds = manifest?.runtimes?.[runtimeName]?.provider_ids ?? [];
	return providerIds
		.filter((providerId) => Object.hasOwn(providers, providerId))
		.map((providerId) => [providerId, providers[providerId]]);
}

function hostedRuntimePrimaryModel(
	manifest: RuntimeManifest,
	runtimeName: string | undefined,
): AgentPrimaryModel | null {
	const runtime = runtimeName ? manifest.runtimes[runtimeName] : undefined;
	return runtime?.primary_model ?? null;
}

function hostedProviderModels(
	input: Record<string, unknown>,
	primaryModel: AgentPrimaryModel | null,
	managedModelsOverride?: readonly AiProviderModel[],
): NonNullable<AiProviderCatalog["providers"][number]["models"]> {
	const providerApiMode = hostedProviderApiMode(input);
	// Hosted wire rejects singular model; this fallback serves generic provider projections only.
	const singularModel = stringValue(input.model);
	const rawModels = Array.isArray(input.models) ? input.models : [];
	const manifestModels = rawModels
		.map((model) => (recordValue(model) ? (model as Record<string, unknown>) : null))
		.filter((model): model is Record<string, unknown> => model !== null)
		.map((model) => {
			const id = stringValue(model.id);
			if (!id) return null;
			const apiMode = stringValue(model.api_mode);
			return {
				...model,
				id,
				...(apiMode && isAiProviderApiMode(apiMode) ? { api_mode: apiMode } : {}),
			};
		})
		.filter((model): model is NonNullable<typeof model> => model !== null);
	const manifestModelsById = new Map(manifestModels.map((model) => [model.id, model]));
	const models = managedModelsOverride
		? managedModelsOverride.map((model) => ({
				...manifestModelsById.get(model.id),
				...model,
				id: model.id,
			}))
		: manifestModels;
	if (singularModel && !models.some((model) => model.id === singularModel)) {
		models.unshift({ id: singularModel, api_mode: providerApiMode });
	}
	if (primaryModel && !models.some((model) => model.id === primaryModel.model)) {
		models.unshift({ id: primaryModel.model, api_mode: providerApiMode });
	}
	return models.filter(
		(model, index, entries) => entries.findIndex((entry) => entry.id === model.id) === index,
	);
}

function hostedProviderApiMode(input: Record<string, unknown>): AiProviderApiMode {
	const raw = input.apiMode;
	if (typeof raw === "string" && isAiProviderApiMode(raw)) {
		return raw;
	}
	return "openai_chat";
}

function managedProviderSupportsLiveModelProbe(apiMode: AiProviderApiMode): boolean {
	return apiMode === "openai_chat" || apiMode === "openai_responses";
}

function managedGatewayPrimaryModelTarget(
	manifest: RuntimeManifest,
	runtimeName: string,
): {
	baseUrl: string;
	providerId: string;
	seedModel: string | null;
} | null {
	const providers = recordValue(manifest.projection?.providers);
	if (!providers) return null;
	const rawEntries = hostedProviderEntries(providers, runtimeName, manifest);
	if (rawEntries.length === 0) return null;
	const currentPrimary = hostedRuntimePrimaryModel(manifest, runtimeName);
	const selectedProviderId = currentPrimary?.provider_id ?? null;
	if (!selectedProviderId) return null;
	const selectedProvider = rawEntries.find(
		([providerId]) => providerId === selectedProviderId,
	)?.[1];
	const provider = recordValue(selectedProvider);
	if (!provider || !isClawdiManagedProviderProjection(provider)) return null;
	const baseUrl = stringValue(provider.baseUrl);
	if (!baseUrl) return null;
	const apiMode = hostedProviderApiMode(provider);
	if (!managedProviderSupportsLiveModelProbe(apiMode)) return null;
	return {
		baseUrl,
		providerId: selectedProviderId,
		seedModel:
			currentPrimary && currentPrimary.provider_id === selectedProviderId
				? currentPrimary.model
				: null,
	};
}

interface ManagedGatewayModelOverrides {
	primaryModels: Partial<Record<string, AgentPrimaryModel>>;
	models: Partial<Record<string, AiProviderModel[]>>;
}

function resolveManagedGatewayModelOverrides(
	manifest: RuntimeManifest,
	enabledRuntimes: readonly string[],
	home: string,
	workspaceRoot: string,
	egressSystemCaFile: string | null,
	fetcher: ManagedGatewayModelListFetcher,
): ManagedGatewayModelOverrides {
	const overrides: ManagedGatewayModelOverrides = { primaryModels: {}, models: {} };
	const fetchCache = new Map<string, ManagedGatewayModelFetchResult>();
	for (const runtimeName of enabledRuntimes) {
		const target = managedGatewayPrimaryModelTarget(manifest, runtimeName);
		if (!target) continue;
		const cacheKey = `${target.providerId}\n${target.baseUrl}`;
		let fetchResult = fetchCache.get(cacheKey);
		if (!fetchResult) {
			fetchResult = fetcher({
				baseUrl: target.baseUrl,
				home,
				egressSystemCaFile,
				providerId: target.providerId,
				runtimeName,
				workspaceRoot,
			});
			fetchCache.set(cacheKey, fetchResult);
			if (fetchResult.status === "failed") {
				const loggedProviderId = isClawdiManagedV2ProviderId(target.providerId)
					? CLAWDI_MANAGED_PROVIDER_ID
					: target.providerId;
				console.warn(
					`managed model probe failed for ${runtimeName}/${loggedProviderId} at ${fetchResult.endpoint}: ${fetchResult.detail}; keeping configured seed`,
				);
			}
		}
		const resolution = resolveManagedPrimaryModel({
			seedModel: target.seedModel,
			liveModelIds:
				fetchResult.status === "ok" ? fetchResult.models.map((model) => model.id) : null,
		});
		if (fetchResult.status === "ok" && fetchResult.models.length > 0) {
			overrides.models[runtimeName] = fetchResult.models;
		}
		if (!resolution.resolvedModel) continue;
		if (resolution.resolvedModel === target.seedModel) continue;
		overrides.primaryModels[runtimeName] = {
			provider_id: target.providerId,
			model: resolution.resolvedModel,
		};
	}
	return overrides;
}

const MANAGED_GATEWAY_MODEL_FETCH_TIMEOUT_MS = 3_000;

const MANAGED_GATEWAY_MODEL_FETCH_SCRIPT = [
	"const [url, timeoutRaw] = process.argv.slice(1);",
	"const timeoutMs = Number.parseInt(timeoutRaw ?? '', 10) || 3000;",
	"const controller = new AbortController();",
	"const timer = setTimeout(() => controller.abort(), timeoutMs);",
	"(async () => {",
	"  try {",
	"    const response = await fetch(url, {",
	"      method: 'GET',",
	"      headers: { accept: 'application/json' },",
	"      signal: controller.signal,",
	"    });",
	"    const body = await response.text();",
	"    process.stdout.write(JSON.stringify({ ok: response.ok, status: response.status, body }));",
	"    process.exit(response.ok ? 0 : 1);",
	"  } catch (error) {",
	"    const detail = error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'",
	"      ? 'request timed out'",
	"      : (error instanceof Error ? error.message : String(error));",
	"    process.stderr.write(detail);",
	"    process.exit(2);",
	"  } finally {",
	"    clearTimeout(timer);",
	"  }",
	"})();",
].join("\n");

function fetchManagedGatewayModelList(
	input: ManagedGatewayModelFetchInput,
): ManagedGatewayModelFetchResult {
	const endpoint = buildManagedModelsEndpoint(input.baseUrl);
	if (!input.egressSystemCaFile || !existsSync(input.egressSystemCaFile)) {
		return {
			status: "failed",
			detail: "transparent managed gateway CA bundle is unavailable",
			endpoint,
		};
	}
	const result = spawnRuntimeUserCommand(
		process.execPath,
		[
			"-e",
			MANAGED_GATEWAY_MODEL_FETCH_SCRIPT,
			endpoint,
			String(MANAGED_GATEWAY_MODEL_FETCH_TIMEOUT_MS),
		],
		input.home,
		input.workspaceRoot,
		{
			egressSystemCaFile: input.egressSystemCaFile,
		},
	);
	const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
	const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8");
	if (result.status !== 0) {
		const detail = parseManagedGatewayFetchFailure(stdout, stderr, result.status);
		return { status: "failed", detail, endpoint };
	}
	try {
		const payload = JSON.parse(stdout) as { body?: string };
		const body = payload.body ? JSON.parse(payload.body) : null;
		return { status: "ok", endpoint, models: extractManagedLiveModels(body) };
	} catch (error) {
		return {
			status: "failed",
			detail: `invalid /models response: ${error instanceof Error ? error.message : String(error)}`,
			endpoint,
		};
	}
}

function parseManagedGatewayFetchFailure(
	stdout: string,
	stderr: string,
	status: number | null,
): string {
	try {
		const payload = JSON.parse(stdout) as { status?: unknown };
		if (typeof payload.status === "number") return `HTTP ${payload.status}`;
	} catch {
		// Best-effort parse only.
	}
	const detail = stderr.trim() || stdout.trim();
	return detail || `exit ${status ?? "unknown"}`;
}

function hostedProviderType(input: Record<string, unknown>): AiProviderType {
	const type = stringValue(input.type);
	return type && isAiProviderType(type) ? type : "custom_openai_compatible";
}

function hostedProviderAuth(
	input: Record<string, unknown>,
	hasApiKeySecretRef: boolean,
): AiProviderAuth | null {
	const auth = recordValue(input.auth);
	if (auth) {
		const type = stringValue(auth.type);
		const tool = stringValue(auth.tool);
		const profile = stringValue(auth.profile);
		if (type === "agent_profile" && tool === "codex" && profile) {
			return { type: "agent_profile", tool: "codex", profile };
		}
		if (type === "api_key" || type === "secret_ref") {
			if (hasApiKeySecretRef) {
				return { type: "api_key", source: "managed" };
			}
			return null;
		}
		if (type && type !== "none") return null;
	}
	if (hasApiKeySecretRef) {
		return { type: "api_key", source: "managed" };
	}
	if (hostedProviderRequiresApiKey(input)) {
		return null;
	}
	return { type: "none" };
}

function hostedProviderUnhealthy(input: Record<string, unknown>): boolean {
	const status = stringValue(input.status);
	return Boolean(status && status !== "ok");
}

function hostedProviderRequiresApiKey(input: Record<string, unknown>): boolean {
	if (input.apiKeyRequired === true) return true;
	const auth = recordValue(input.auth);
	const type = auth ? stringValue(auth.type) : null;
	return type === "api_key" || type === "secret_ref";
}

function hostedProviderRuntimeEnvName(providerId: string, input: Record<string, unknown>): string {
	const raw = typeof input.runtimeEnvName === "string" ? input.runtimeEnvName : null;
	if (raw && isEnvKey(raw)) return raw;
	return `CLAWDI_PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function hostedProviderPlaceholderEnv(
	manifest: RuntimeManifest,
	runtimeName?: string,
): Record<string, string> {
	const providers = recordValue(manifest.projection?.providers);
	if (!providers) return {};
	const env: Record<string, string> = {};
	for (const [providerId, raw] of hostedProviderEntries(providers, runtimeName, manifest)) {
		const provider = recordValue(raw);
		if (!provider) continue;
		if (!isClawdiManagedProviderProjection(provider)) continue;
		const apiKeySecretRef = stringValue(provider.apiKeySecretRef);
		if (!apiKeySecretRef) continue;
		const runtimeEnvName = hostedProviderRuntimeEnvName(providerId, provider);
		if (!isEnvKey(runtimeEnvName)) continue;
		env[runtimeEnvName] = MANAGED_EGRESS_PLACEHOLDER_VALUE;
	}
	return env;
}

function hostedProviderSecretEnv(
	manifest: RuntimeManifest,
	runtimeName?: string,
): Record<string, string> {
	const providers = recordValue(manifest.projection?.providers);
	if (!providers) return {};
	const secretEnv: Record<string, string> = {};
	for (const [providerId, raw] of hostedProviderEntries(providers, runtimeName, manifest)) {
		const provider = recordValue(raw);
		if (!provider) continue;
		if (isClawdiManagedProviderProjection(provider)) continue;
		const apiKeySecretRef = stringValue(provider.apiKeySecretRef);
		if (!apiKeySecretRef) continue;
		const runtimeEnvName = hostedProviderRuntimeEnvName(providerId, provider);
		if (!isEnvKey(runtimeEnvName)) continue;
		secretEnv[runtimeEnvName] = apiKeySecretRef;
	}
	return secretEnv;
}

function assertNoProviderEnvOverlap(
	runtimeName: string,
	placeholderEnv: Record<string, string>,
	secretEnv: Record<string, string>,
): void {
	for (const envName of Object.keys(placeholderEnv)) {
		if (secretEnv[envName] === undefined) continue;
		throw new Error(
			`runtime ${runtimeName} provider env ${envName} is both managed and BYOK-backed`,
		);
	}
}

function mergeRuntimeEnvWithProviderPlaceholders(
	runtimeName: string,
	settings: RuntimeManifest["runtimes"][string]["run"],
	providerEnv: Record<string, string>,
): RuntimeManifest["runtimes"][string]["run"] {
	if (Object.keys(providerEnv).length === 0) return settings;
	const userEnv = settings?.env ?? {};
	for (const envName of Object.keys(providerEnv)) {
		if (settings?.secretEnv?.[envName] !== undefined) {
			throw new Error(
				`runtime ${runtimeName} provider placeholder ${envName} conflicts with secretEnv`,
			);
		}
	}
	return {
		...(settings ?? {}),
		prependPath: settings?.prependPath ?? [],
		env: {
			...userEnv,
			...providerEnv,
		},
	};
}

function mergeRuntimeServiceEnvWithProviderPlaceholders(
	runtimeName: string,
	serviceName: string,
	settings: NonNullable<RuntimeManifest["runtimes"][string]["services"]>[string],
	providerEnv: Record<string, string>,
): NonNullable<RuntimeManifest["runtimes"][string]["services"]>[string] {
	if (Object.keys(providerEnv).length === 0) return settings;
	for (const envName of Object.keys(providerEnv)) {
		if (settings.secretEnv?.[envName] !== undefined) {
			throw new Error(
				`runtime ${runtimeName} service ${serviceName} provider placeholder ${envName} conflicts with secretEnv`,
			);
		}
	}
	return {
		...settings,
		env: {
			...(settings.env ?? {}),
			...providerEnv,
		},
	};
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

function runtimeSecretFilePath(paths: RuntimePaths, runtimeName: string): string {
	return join(paths.runtimeSecretFileRoot, `${runtimeName}.json`);
}

function writeRuntimeProviderSecretFile(
	runtimeName: string,
	secretValues: Record<string, string> | undefined,
	secretEnv: Record<string, string>,
	paths: RuntimePaths,
): string | null {
	return writeScopedSecretValues(
		runtimeSecretFilePath(paths, runtimeName),
		secretValues,
		Object.values(secretEnv),
		paths,
		"runtime-user",
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
	paths: RuntimePaths,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): RuntimeEgressSecretMaterial {
	const resolver = createRuntimeSecretResolver(manifest, paths, secretValues, runtimeEnvironment);
	const scoped = scopedSecretValues(secretValues, egressSecretRefs(manifest), {
		resolveEnv: true,
		resolver,
		require: (ref) => resolver.isPrivateFileBacked(ref),
	});
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
	writePrivateFileAtomic(path, material.content, { mode: 0o600, dirMode: 0o700 });
	makeRootOwned(dirname(path));
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
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): {
	path: string | null;
	changed: boolean;
	material: RuntimeEgressSecretMaterial;
	previousRevision: string | null;
} {
	const secretFilePath = egressSecretFilePath(paths);
	const previousContent = existsSync(secretFilePath) ? readFileSync(secretFilePath, "utf-8") : null;
	const material = egressSecretMaterial(manifest, secretValues, paths, runtimeEnvironment);
	const path = writeEgressSecretMaterial(material, paths);
	return {
		path,
		changed: previousContent !== material.content,
		material,
		previousRevision: egressSecretRevisionFromContent(previousContent),
	};
}

function committedEgressSecretMaterial(
	paths: RuntimePaths,
	committedRevision: string,
): RuntimeEgressSecretMaterial {
	const material = verifiedCommittedEgressSecretMaterial(paths);
	if (!material) {
		throw new Error("could not verify committed egress secret rollback authority");
	}
	if (material.revision !== committedRevision) {
		throw new Error("committed egress secret rollback authority does not match applied state");
	}
	return material;
}

function verifiedCommittedEgressSecretMaterial(
	paths: RuntimePaths,
): RuntimeEgressSecretMaterial | null {
	try {
		const committed = loadCommittedRuntimeManifest(paths);
		if ("errors" in committed) return null;
		if (egressSecretRefs(committed.manifest).some(isEnvSecretRef)) return null;
		if (!committed.applyContext) return null;
		return egressSecretMaterial(
			committed.manifest,
			committed.secretValues,
			paths,
			committed.applyContext.runtimeEnvironment,
		);
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

function isEnvKey(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

interface HostedAiProviderProjectionResult {
	path: string | null;
	revision: string | null;
	providerIds: string[];
}

const CODEX_MANAGED_PROVIDER_ID = "clawdi-managed";
const CODEX_MANAGED_PROVIDER_CONFIG_FILE = "config.toml";
const CODEX_MANAGED_ENV_KEY = "OPENAI_API_KEY";
const CODEX_NPM_PACKAGE_VERSION = "0.142.4";
const CODEX_NPM_PACKAGE_SPEC = `@openai/codex@${CODEX_NPM_PACKAGE_VERSION}`;

interface HostedCodexManagedProvider {
	providerId: string;
	baseUrl: string;
	model: string | null;
	apiMode: string | null;
	apiKeySecretRef: string | null;
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

interface ManagedGatewayModelFetchInput {
	baseUrl: string;
	home: string;
	egressSystemCaFile: string | null;
	providerId: string;
	runtimeName: string;
	workspaceRoot: string;
}

type ManagedGatewayModelFetchResult =
	| {
			status: "ok";
			endpoint: string;
			models: AiProviderModel[];
	  }
	| {
			status: "failed";
			detail: string;
			endpoint: string;
	  };

type ManagedGatewayModelListFetcher = (
	input: ManagedGatewayModelFetchInput,
) => ManagedGatewayModelFetchResult;

function applyHostedAiProviderProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
	home: string,
	workspaceRoot: string,
	previousProviderIds: readonly string[],
	managedModelOverrides: ManagedGatewayModelOverrides,
): HostedAiProviderProjectionResult {
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return { path: null, revision: null, providerIds: [] };
	}
	const projectionInput = agentTargetProjectionInput(
		hostedAiProviderCatalog(manifest, name, {
			primaryModelOverride: managedModelOverrides.primaryModels[name],
			managedModelsOverride: managedModelOverrides.models[name],
		}),
	);
	assertHostedProviderProjectionMode(name, manifest, projectionInput);
	if (manifest.runtimes[name]?.providerMode === "configured" && !projectionInput) {
		if (name === "openclaw") {
			applyOpenClawGatewayHostedProjection(
				observation.commandPath,
				manifest,
				secretValues,
				runtimeEnvironment,
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
			runtimeEnvironment,
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
	managedModelOverrides: ManagedGatewayModelOverrides,
): string | null {
	if (
		(name !== "openclaw" && name !== "hermes") ||
		!observation.enabled ||
		observation.status === "install_failed" ||
		!observation.commandPath
	) {
		return null;
	}
	const projectionInput = agentTargetProjectionInput(
		hostedAiProviderCatalog(manifest, name, {
			primaryModelOverride: managedModelOverrides.primaryModels[name],
			managedModelsOverride: managedModelOverrides.models[name],
		}),
	);
	assertHostedProviderProjectionMode(name, manifest, projectionInput);
	if (manifest.runtimes[name]?.providerMode === "configured" && !projectionInput) {
		return null;
	}
	if (name === "openclaw") {
		const providerPatch = buildOpenClawHostedProviderPatch(projectionInput, previousProviderIds);
		if (!projectionInput) {
			return revisionHash({
				openClawProviderProjection: "delete",
				patch: JSON.parse(providerPatch.content) as unknown,
			});
		}
		return revisionHash({
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
		revision: revisionHash({
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
	if (
		codex?.enabled !== true ||
		!provider ||
		provider.managed_by !== "clawdi" ||
		apiMode !== "openai_responses" ||
		stringValue(provider.runtimeEnvName) !== CODEX_MANAGED_ENV_KEY ||
		normalizeSecretRef(stringValue(provider.apiKeySecretRef)) !== "secret://tool.codex.apiKey" ||
		!providerId ||
		stringValue(primaryModel?.provider_id) !== providerId ||
		!baseUrl
	) {
		return null;
	}
	return {
		providerId,
		baseUrl,
		model: stringValue(primaryModel?.model),
		apiMode,
		apiKeySecretRef: stringValue(provider.apiKeySecretRef),
	};
}

function hostedCodexHome(home: string): string {
	const configured = process.env.CODEX_HOME?.trim();
	if (!configured) return join(home, ".codex");
	if (configured === "~") return home;
	if (configured.startsWith("~/")) return join(home, configured.slice(2));
	return configured;
}

function hostedCodexManagedConfigToml(provider: HostedCodexManagedProvider): string {
	const lines = ["# Managed by Clawdi hosted runtime. Do not put API keys in this file."];
	const model = provider.model?.trim();
	if (model) lines.push(`model = ${quoteTomlString(model)}`);
	lines.push(
		`model_provider = ${quoteTomlString(CODEX_MANAGED_PROVIDER_ID)}`,
		"",
		`[model_providers.${CODEX_MANAGED_PROVIDER_ID}]`,
		'name = "Clawdi Managed OpenAI"',
		`base_url = ${quoteTomlString(provider.baseUrl)}`,
		'wire_api = "responses"',
		`env_key = ${quoteTomlString(CODEX_MANAGED_ENV_KEY)}`,
		"",
	);
	return lines.join("\n");
}

function ensureHostedCodexCli(paths: RuntimePaths): Record<string, string> | null {
	if (process.env.CLAWDI_CODEX_INSTALL_DISABLED === "1") return null;
	const npmPrefix = join(paths.serviceStateRoot, "codex", "npm");
	const npmCache = join(paths.serviceStateRoot, "codex", "npm-cache");
	const realBin = join(npmPrefix, "bin", "codex");
	const commandPath = join(runtimeManagedBinDir(paths), "codex");
	let installedVersion = hostedCodexInstalledVersion(npmPrefix);
	if (installedVersion !== CODEX_NPM_PACKAGE_VERSION || !executableExists(realBin)) {
		installHostedCodexCli(CODEX_NPM_PACKAGE_SPEC, npmPrefix, npmCache);
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
	makeRootReadableDir(dirname(npmPrefix));
	publishRootOwnedToolTree(npmPrefix);
	writeHostedCodexCommandShim(commandPath, realBin);
	return {
		commandPath,
		npmCache,
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

function installHostedCodexCli(packageSpec: string, npmPrefix: string, npmCache: string): void {
	if (!commandExists("npm")) {
		throw new Error("Codex runtime add-on install requires npm on PATH");
	}
	mkdirSync(npmPrefix, { recursive: true });
	mkdirSync(npmCache, { recursive: true });
	const result = spawnSync(
		"npm",
		[
			"install",
			"-g",
			"--prefix",
			npmPrefix,
			"--cache",
			npmCache,
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
		{
			encoding: "utf8",
			env: {
				...process.env,
				NO_UPDATE_NOTIFIER: "1",
				NPM_CONFIG_UPDATE_NOTIFIER: "false",
			},
			timeout: Number.parseInt(process.env.CLAWDI_CODEX_INSTALL_TIMEOUT ?? "600000", 10),
		},
	);
	if (result.status !== 0) {
		throw new Error(
			`Codex runtime add-on install failed: ${tail(result.stderr) ?? tail(result.stdout) ?? "npm failed"}`,
		);
	}
}

function writeHostedCodexCommandShim(commandPath: string, realBin: string): void {
	const binDir = dirname(commandPath);
	makeRootReadableDir(binDir);
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
	makeRootOwned(commandPath);
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
			revision: revisionHash({
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
		revision: revisionHash({
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
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): Record<string, unknown> | null {
	const allowedOrigins = openClawControlUiAllowedOrigins(manifest);
	const gatewayToken = runtimeSecretValue(
		secretValues ?? {},
		manifest.openclawGatewayAuth?.tokenRef ?? `env://${OPENCLAW_GATEWAY_TOKEN_ENV}`,
		runtimeEnvironment,
	);
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
										...(nativeAuth ? { token: null } : { token: gatewayToken }),
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
	runtimeEnvironment: RuntimeEnvironmentAuthority,
	home: string,
	workspaceRoot: string,
): void {
	const patch = openClawGatewayHostedPatch(manifest, secretValues, runtimeEnvironment);
	if (!patch) return;
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
				hermesManagedChannelsPatch(
					channels,
					manifest.controlPlane.apiUrl,
					manifest.projection?.channelCredentials,
				),
			);
			makeRuntimeUserOwned(configPath);
		});
		return configPath;
	}
	runRuntimeUserCommand(
		observation.commandPath,
		["config", "patch", "--stdin"],
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
	cloudApiUrl: string,
	channelCredentials: unknown,
): Record<string, Record<string, unknown>> {
	const baseUrl = stripTrailingSlash(cloudApiUrl);
	const telegramEnabled = channelHasAccounts(channels.telegram);
	const whatsapp = hermesWhatsAppProjection(channels, channelCredentials, baseUrl);
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
		discord: channelHasAccounts(channels.discord)
			? {
					enabled: true,
					dm_policy: "open",
					group_policy: "open",
					allow_from: ["*"],
					group_allow_from: ["*"],
					require_mention: false,
					thread_require_mention: false,
					bots_require_inline_mention: false,
				}
			: { enabled: false },
		whatsapp: whatsapp
			? {
					enabled: true,
					dm_policy: "open",
					group_policy: "open",
					allow_from: ["*"],
					group_allow_from: ["*"],
					require_mention: false,
				}
			: { enabled: false },
		platforms: {
			telegram: {
				extra: {
					group_sessions_per_user: telegramEnabled ? false : null,
				},
			},
			whatsapp: whatsapp
				? {
						enabled: true,
						extra: {
							session_path: whatsapp.sessionDir,
							ws_url: whatsapp.wsUrl,
						},
					}
				: { enabled: false },
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

function hermesWhatsAppProjection(
	channels: Record<string, unknown>,
	channelCredentials: unknown,
	baseUrl: string,
): { sessionDir: string; wsUrl: string } | null {
	if (!WHATSAPP_UPSTREAM_READY) return null;
	if (!channelHasAccounts(channels.whatsapp)) return null;
	if (!Array.isArray(channelCredentials)) return null;
	for (const credential of channelCredentials) {
		const record = recordValue(credential);
		if (record?.provider !== "whatsapp" || record.kind !== "whatsapp_baileys_auth_state") {
			continue;
		}
		const accountId = stringValue(record.accountId);
		const targets = recordValue(record.targets);
		const hermesTarget = targets ? recordValue(targets.hermes) : null;
		const sessionDir = hermesTarget
			? (stringValue(hermesTarget.sessionDir) ?? stringValue(hermesTarget.authDir))
			: null;
		if (!accountId || !sessionDir) continue;
		return {
			sessionDir,
			wsUrl: `${toWebSocketUrl(baseUrl)}/v1/channels/whatsapp/${accountId}/baileys`,
		};
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

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function toWebSocketUrl(baseUrl: string): string {
	if (baseUrl.startsWith("https://")) return `wss://${baseUrl.slice("https://".length)}`;
	if (baseUrl.startsWith("http://")) return `ws://${baseUrl.slice("http://".length)}`;
	return baseUrl;
}

function openClawManagedChannelsPatch(channels: Record<string, unknown>): Record<string, unknown> {
	const deleteEntries = openClawManagedChannelDeletes();
	const runtimeReadyChannels = openClawRuntimeReadyChannels(channels);
	const usesEnvSecretRefs = openClawManagedChannelUsesEnvSecretRefs(runtimeReadyChannels);
	const isolatesTelegramDms = channelHasAccounts(runtimeReadyChannels.telegram);
	return {
		channels: {
			...deleteEntries,
			...runtimeReadyChannels,
		},
		plugins: {
			entries: {
				...deleteEntries,
				...channelPluginEntries(runtimeReadyChannels),
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
			dmScope: isolatesTelegramDms ? "per-account-channel-peer" : null,
		},
	};
}

function openClawRuntimeReadyChannels(channels: Record<string, unknown>): Record<string, unknown> {
	if (WHATSAPP_UPSTREAM_READY || !Object.hasOwn(channels, "whatsapp")) return channels;
	const runtimeReadyChannels = { ...channels };
	delete runtimeReadyChannels.whatsapp;
	return runtimeReadyChannels;
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
		if (channel === "whatsapp" && !WHATSAPP_UPSTREAM_READY) continue;
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
		target.expectedCurrentRevision = currentRevision();
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
const HOSTED_MCP_LEDGER_SCHEMA_VERSION = "clawdi.hostedManagedMcpServers.v1";
const HOSTED_MCP_LEDGER_FILE = "managed-mcp-servers.json";

interface HostedMcpManagedLedger {
	schemaVersion: typeof HOSTED_MCP_LEDGER_SCHEMA_VERSION;
	runtimes: Partial<
		Record<(typeof HOSTED_RUNTIME_TARGETS)[number], Record<string, HostedMcpServerDesiredState>>
	>;
}

function hostedMcpIntent(manifest: RuntimeManifest): HostedMcpIntent {
	const value = manifest.projection?.mcp;
	if (value === undefined) return { servers: {} };
	return { servers: hostedMcpDesiredStateSchema.parse(value).servers };
}

function hostedMcpLedgerPath(paths: RuntimePaths): string {
	return join(paths.projectionRoot, HOSTED_MCP_LEDGER_FILE);
}

function readHostedMcpManagedLedger(paths: RuntimePaths): HostedMcpManagedLedger {
	const path = hostedMcpLedgerPath(paths);
	if (!existsSync(path)) {
		return { schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION, runtimes: {} };
	}
	let payload: unknown;
	try {
		payload = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(
			`hosted MCP last-applied ledger is invalid: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (!isPlainRecord(payload) || payload.schemaVersion !== HOSTED_MCP_LEDGER_SCHEMA_VERSION) {
		throw new Error("hosted MCP last-applied ledger has an unsupported schema");
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
		const servers = runtimes[runtime];
		if (servers === undefined) continue;
		if (!isPlainRecord(servers)) {
			throw new Error(`hosted MCP last-applied ledger has invalid ${runtime} servers`);
		}
		const normalizedServers: Record<string, HostedMcpServerDesiredState> = {};
		for (const [name, server] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
			if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
				throw new Error(`hosted MCP last-applied ledger has invalid ${runtime} server name`);
			}
			const parsed = hostedMcpServerDesiredStateSchema.safeParse(server);
			if (!parsed.success) {
				throw new Error(`hosted MCP last-applied ledger has invalid ${runtime} server ${name}`);
			}
			normalizedServers[name] = parsed.data;
		}
		if (Object.keys(normalizedServers).length > 0) normalized[runtime] = normalizedServers;
	}
	return { schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION, runtimes: normalized };
}

function writeHostedMcpManagedLedger(paths: RuntimePaths, ledger: HostedMcpManagedLedger): void {
	writeJsonFile(hostedMcpLedgerPath(paths), {
		schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION,
		runtimes: Object.fromEntries(
			HOSTED_RUNTIME_TARGETS.flatMap((runtime) => {
				const servers = ledger.runtimes[runtime];
				return servers && Object.keys(servers).length > 0
					? [
							[
								runtime,
								Object.fromEntries(Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))),
							],
						]
					: [];
			}),
		),
	});
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

function hostedBundledSkillTargetDir(name: string, skillName: string, home: string): string | null {
	if (name !== "openclaw" && name !== "hermes") return null;
	const agentHome = name === "openclaw" ? join(home, ".openclaw") : join(home, ".hermes");
	return agentSkillTargetDir(name, skillName, agentHome);
}

function validateHostedBundledSkillsPlan(
	name: string,
	manifest: RuntimeManifest,
	home: string,
): void {
	if (!hostedBundledSkillsEnabled()) return;
	for (const [skillName, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
		const bundled = resolveHostedBundledSkill(skillName, desired.version);
		const targetDir = hostedBundledSkillTargetDir(name, skillName, home);
		const runtimeEnabled = manifest.runtimes[name]?.enabled === true;
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

function applyHostedBundledSkills(
	name: string,
	observation: RuntimeInstallObservation | undefined,
	manifest: RuntimeManifest,
	home: string,
): string[] {
	// Reservation state is root-authoritative. Drop privilege only inside the
	// callbacks that mutate runtime-user-owned Skill trees.
	const installEnabled = hostedBundledSkillsEnabled();
	const targets: string[] = [];
	for (const skillName of hostedBundledSkillIds()) {
		const targetDir = hostedBundledSkillTargetDir(name, skillName, home);
		if (!targetDir) continue;
		targets.push(targetDir);
		const desired = manifest.projection?.skills?.entries[skillName];
		const runtimeEnabled = manifest.runtimes[name]?.enabled === true;
		if (!installEnabled || !runtimeEnabled || desired?.enabled !== true) {
			const reservationOwner = managedSkillReservationOwner(targetDir, skillName);
			const legacy = adoptableLegacyHostedBundledSkill(targetDir, skillName);
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
					withRuntimeUserFileAccess(() => rmSync(targetDir, { recursive: true, force: true })),
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
		// Root captures and verifies the source before the callback drops to the
		// runtime identity. The callback can only mutate the target from bytes.
		const bundle = loadHostedBundledSkill(
			skillName,
			desired.version,
			hostedBundledSkillSourceDir(bundled.assetDirectory),
		);
		const result = installReservedManagedSkill(
			{
				targetDir,
				id: skillName,
				manager: "hosted-manifest",
				version: desired.version,
				digest: bundled.digest,
			},
			() =>
				withRuntimeUserFileAccess(() =>
					reconcileHostedBundledSkill({
						bundle,
						targetDir,
						reserved: true,
					}),
				),
		);
		if (result === "unchanged") continue;
	}
	return targets;
}

function hostedBundledSkillProjection(
	manifest: RuntimeManifest,
	runtime: string,
): Array<{ id: string; version: number; digest: string }> | null {
	if (runtime !== "openclaw" && runtime !== "hermes") return null;
	if (manifest.runtimes[runtime]?.enabled !== true) return [];
	return hostedBundledSkillIds()
		.sort((left, right) => left.localeCompare(right))
		.flatMap((skillId) => {
			const desired = manifest.projection?.skills?.entries[skillId];
			if (desired?.enabled !== true) return [];
			const bundled = resolveHostedBundledSkill(skillId, desired.version);
			return [{ id: bundled.id, version: bundled.version, digest: bundled.digest }];
		});
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
	if (Object.keys(plan.nextLedger.runtimes).length > 0 || existsSync(ledgerPath)) {
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
		const previousServers = ledger.runtimes[name] ?? {};
		const native = readHostedMcpNativeState(name, home);
		for (const serverName of Object.keys(desiredServers).sort()) {
			if (Object.hasOwn(previousServers, serverName)) continue;
			if (Object.hasOwn(native.servers, serverName)) {
				throw new Error(`refusing to replace unmanaged ${name} MCP server ${serverName}`);
			}
		}
		const mutations: HostedMcpMutation[] = [];
		for (const serverName of Object.keys(previousServers).sort()) {
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
			nextLedger.runtimes[name] = Object.fromEntries(
				Object.entries(desiredServers).sort(([a], [b]) => a.localeCompare(b)),
			);
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

function runtimeUserCommandEnv(
	home: string,
	options: { egressSystemCaFile?: string } = {},
): NodeJS.ProcessEnv {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : null;
	const uid =
		runtimeUser && runtimeUser !== "root" && (runningAsRoot() || effectiveUid !== null)
			? String(runningAsRoot() ? runtimeUserUid(runtimeUser) : effectiveUid)
			: null;
	const runtimeDir = uid ? `/run/user/${uid}` : null;
	const env = {
		...process.env,
		HOME: home,
		PATH: [join(home, ".local", "bin"), join(home, ".openclaw", "bin"), process.env.PATH]
			.filter(Boolean)
			.join(":"),
		...(runtimeDir
			? {
					XDG_RUNTIME_DIR: runtimeDir,
					DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
				}
			: {}),
	};
	if (options.egressSystemCaFile) {
		applyEgressTransparentRuntimeEnv(env, { caFile: options.egressSystemCaFile });
	}
	return env;
}

function runtimeUserGid(runtimeUser: string): number {
	const explicit = Number.parseInt(process.env.CLAWDI_RUNTIME_GID?.trim() ?? "", 10);
	if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 4_294_967_295) {
		return explicit;
	}
	const resolved = spawnSync("id", ["-g", runtimeUser], { encoding: "utf8" });
	if (resolved.status === 0) {
		const gid = Number.parseInt(resolved.stdout.trim(), 10);
		if (Number.isInteger(gid) && gid >= 0 && gid <= 4_294_967_295) return gid;
	}
	if (runtimeUser === "clawdi") return 10_001;
	throw new Error(`could not resolve runtime gid for ${runtimeUser}`);
}

function userManagerControlSocketExists(runtimeDir: string): boolean {
	return existsSync(join(runtimeDir, "bus")) || existsSync(join(runtimeDir, "systemd", "private"));
}

function waitForUserManagerControlSocket(runtimeDir: string): boolean {
	const waitUntil = Date.now() + 120_000;
	const waitBuffer = new SharedArrayBuffer(4);
	const waitView = new Int32Array(waitBuffer);
	while (Date.now() < waitUntil) {
		if (userManagerControlSocketExists(runtimeDir)) return true;
		Atomics.wait(waitView, 0, 0, 200);
	}
	return userManagerControlSocketExists(runtimeDir);
}

function ensureRuntimeUserManagerReady(runtimeUser: string): void {
	if (!runningAsRoot() || runtimeUser === "root" || !commandExists("systemctl")) return;
	const uid = runtimeUserUid(runtimeUser);
	const gid = runtimeUserGid(runtimeUser);
	const runtimeDir = `/run/user/${uid}`;
	execFileSync("install", ["-d", "-m", "0755", "-o", "root", "-g", "root", "/run/user"]);
	execFileSync("install", ["-d", "-m", "0700", "-o", String(uid), "-g", String(gid), runtimeDir]);
	if (userManagerControlSocketExists(runtimeDir)) return;
	const unit = `user@${uid}.service`;
	let result = spawnSync("systemctl", ["restart", unit], { stdio: "ignore" });
	if (result.status !== 0) {
		result = spawnSync("systemctl", ["start", unit], { stdio: "ignore" });
	}
	if (result.status !== 0 || !waitForUserManagerControlSocket(runtimeDir)) {
		throw new Error(
			`runtime user systemd manager did not publish a control socket under ${runtimeDir}`,
		);
	}
}

// Only official service installers may invoke systemctl --user. Config,
// projection, plugin, and installer commands need privilege drop but not a manager.
function ensureConfiguredRuntimeUserManagerReady(): void {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (runtimeUser) ensureRuntimeUserManagerReady(runtimeUser);
}

function spawnRuntimeUserCommand(
	command: string,
	args: string[],
	home: string,
	cwd: string,
	options: { egressSystemCaFile?: string } = {},
): ReturnType<typeof spawnSync> {
	const env = runtimeUserCommandEnv(home, options);
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (runningAsRoot() && runtimeUser && runtimeUser !== "root") {
		if (commandExists("gosu")) {
			return spawnSync("gosu", [runtimeUser, command, ...args], {
				env: { ...env, USER: runtimeUser, LOGNAME: runtimeUser },
				cwd,
				encoding: "utf8",
			});
		}
		if (commandExists("runuser")) {
			return spawnSync(
				"runuser",
				["-u", runtimeUser, "--", "env", `HOME=${home}`, `PATH=${env.PATH}`, command, ...args],
				{ env, cwd, encoding: "utf8" },
			);
		}
		throw new Error(
			`runtime init is running as root but cannot drop to CLAWDI_RUNTIME_USER=${runtimeUser}; install gosu or runuser`,
		);
	}
	return spawnSync(command, args, { env, cwd, encoding: "utf8" });
}

function runRuntimeUserCommand(
	command: string,
	args: string[],
	stdin: string,
	home: string,
	cwd: string,
	options: { egressSystemCaFile?: string } = {},
): void {
	const env = runtimeUserCommandEnv(home, options);
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (runningAsRoot() && runtimeUser && runtimeUser !== "root") {
		if (commandExists("gosu")) {
			execFileSync("gosu", [runtimeUser, command, ...args], {
				input: stdin,
				env: { ...env, USER: runtimeUser, LOGNAME: runtimeUser },
				cwd,
				stdio: "pipe",
			});
			return;
		}
		if (commandExists("runuser")) {
			execFileSync(
				"runuser",
				["-u", runtimeUser, "--", "env", `HOME=${home}`, `PATH=${env.PATH}`, command, ...args],
				{ input: stdin, env, cwd, stdio: "pipe" },
			);
			return;
		}
		throw new Error(
			`runtime init is running as root but cannot drop to CLAWDI_RUNTIME_USER=${runtimeUser}; install gosu or runuser`,
		);
	}
	execFileSync(command, args, { input: stdin, env, cwd, stdio: "pipe" });
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

function officialServiceCurrentRevision(
	program: RuntimeSystemdUserProgram,
	paths: RuntimePaths,
): string | null {
	const descriptor = officialRuntimeServiceDescriptorForProgram(program);
	if (!descriptor) return null;
	const unitName = systemdUnitFileName(descriptor.programName);
	const unitPath = join(paths.systemdUserRoot, unitName);
	try {
		const contents = readFileSync(unitPath);
		if (isGeneratedRuntimeSystemdFile(contents.toString("utf8"))) return null;
		const stat = lstatSync(unitPath);
		if (!stat.isFile()) return null;
		const command = officialRuntimeServiceCommand(descriptor, paths);
		const commandRevision = runtimeCommandCurrentRevision(command, paths.userHome, paths.userHome);
		if (!commandRevision) return null;
		return runtimeContentSha256({
			commandRevision,
			programName: descriptor.programName,
			unitName,
			unitSha256: createHash("sha256").update(contents).digest("hex"),
			unitMode: stat.mode & 0o7777,
			unitUid: stat.uid,
			unitGid: stat.gid,
		});
	} catch {
		return null;
	}
}

function officialServiceDesiredRevision(input: { program: RuntimeSystemdUserProgram }): string {
	const descriptor = officialRuntimeServiceDescriptorForProgram(input.program);
	if (!descriptor) throw new Error("official service receipt requires an official service program");
	return runtimeContentSha256({
		runtime: descriptor.runtime,
		programName: descriptor.programName,
		serviceIdentity: descriptor.service,
		installerCommand: descriptor.command,
		installArgs: descriptor.installArgs,
	});
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
	try {
		writeRuntimeInstallReceipts(receipts, paths);
	} catch {
		// Receipt persistence is an optimization. Failing closed means the next
		// convergence executes the unchanged official install commands again.
	}
}

function commitRuntimeInstallReceiptGroup(
	receipts: Record<string, RuntimeInstallReceiptEntry>,
	targets: Map<string, RuntimeInstallReceiptTarget>,
): void {
	for (const [key, target] of [...targets].sort(([left], [right]) => left.localeCompare(right))) {
		if (!target.expectedCurrentRevision) continue;
		const currentRevision = target.currentRevision();
		if (currentRevision !== target.expectedCurrentRevision) continue;
		receipts[key] = { desiredRevision: target.desiredRevision, currentRevision };
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
	writeJsonFile(paths.egressEngineStatus, result);
	makeRootOwned(dirname(paths.egressEngineStatus));
	makeRootOwned(paths.egressEngineStatus);
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

function writeEgressAddon(paths: RuntimePaths): { path: string; sha256: string } {
	const source = resolvePackagedEgressAddon();
	const content = readFileSync(source, "utf-8");
	writePrivateFileAtomic(paths.egressAddon, content, { mode: 0o644, dirMode: 0o755 });
	makeRootOwned(dirname(paths.egressAddon));
	makeRootOwned(paths.egressAddon);
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
		CLAWDI_EGRESS_ENGINE_BINARY_PATH: input.program.engine.binaryPath,
		CLAWDI_EGRESS_ADDON_PATH: input.program.addonPath,
		CLAWDI_EGRESS_ADDON_SHA256: input.program.addonSha256,
	};
	const lines = Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${systemdEnvironmentFileQuote(value)}`);
	writePrivateFileAtomic(input.paths.egressTransparentEnv, `${lines.join("\n")}\n`, {
		mode: 0o644,
		dirMode: 0o755,
	});
	makeRootOwned(dirname(input.paths.egressTransparentEnv));
	makeRootOwned(input.paths.egressTransparentEnv);
	return input.paths.egressTransparentEnv;
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

function removeStaleRuntimeSecretFiles(
	writtenRuntimeSecretIds: Set<string>,
	paths: RuntimePaths,
): void {
	if (!existsSync(paths.runtimeSecretFileRoot)) return;
	for (const entry of readdirSync(paths.runtimeSecretFileRoot)) {
		if (!entry.endsWith(".json")) continue;
		const id = entry.slice(0, -".json".length);
		if (!runtimeNameSchema.safeParse(id).success) continue;
		if (!writtenRuntimeSecretIds.has(id)) {
			rmSync(join(paths.runtimeSecretFileRoot, entry), { force: true });
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
	whatsapp: ["clawhub:@openclaw/whatsapp", "@openclaw/whatsapp"],
};

const OPENCLAW_MANAGED_CHANNELS = ["telegram", "discord", "whatsapp"] as const;
const OPENCLAW_GATEWAY_TOKEN_ENV = "OPENCLAW_GATEWAY_TOKEN";

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

function liveSyncEnvironmentIndexPath(paths: RuntimePaths): string {
	return join(paths.serviceStateRoot, "config", "runtime-live-sync-agents.json");
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
	writePrivateFileAtomic(
		liveSyncEnvironmentIndexPath(paths),
		`${JSON.stringify(
			{
				schemaVersion: "clawdi.liveSyncEnvironments.v1",
				agentTypes: [...agentTypes].sort(),
			},
			null,
			2,
		)}\n`,
		{ mode: 0o644, dirMode: 0o755 },
	);
}

function writeDaemonAuthToken(
	paths: RuntimePaths,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): string | null {
	const path = ensureRuntimeAuthTokenFile(paths, runtimeEnvironment);
	if (!path) return null;
	makeManagedSecretRoot(dirname(path));
	makeRootOwned(path);
	return path;
}

function daemonAuthTokenRevision(token: string): string {
	return runtimeContentSha256({
		schemaVersion: "clawdi.daemonAuthTokenRevision.v1",
		token,
	});
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const input = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(input)
				.sort()
				.map((key) => [key, canonicalize(input[key])]),
		);
	}
	return value;
}

function revisionHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex")
		.slice(0, 32);
}

export function runtimeProgramRevision(
	manifest: RuntimeManifest,
	runtime: string,
	secretValues: Record<string, string> | undefined,
	providerProjectionRevision: string | null = null,
	runtimeEnvironment: RuntimeEnvironmentAuthority = projectedRuntimeEnvironment({}),
): string {
	const desiredRuntime = manifest.runtimes[runtime];
	const desiredProgram = desiredRuntime
		? Object.fromEntries(Object.entries(desiredRuntime).filter(([field]) => field !== "services"))
		: null;
	const runtimeSecretRefs = desiredRuntime
		? Object.values(
				mergeRuntimeSecretEnv(runtime, desiredRuntime, hostedProviderSecretEnv(manifest, runtime)),
			)
		: [];
	const channels = hostedChannelProjection(manifest);
	const hostedTarget = runtime === "openclaw" || runtime === "hermes";
	const channelProjection = channels
		? runtime === "openclaw"
			? openClawManagedChannelsPatch(channels)
			: runtime === "hermes"
				? hermesManagedChannelsPatch(
						channels,
						manifest.controlPlane.apiUrl,
						manifest.projection?.channelCredentials,
					)
				: null
		: null;
	return revisionHash({
		renderedProjection: {
			channels: channelProjection,
			gateway:
				runtime === "openclaw"
					? openClawGatewayHostedPatch(manifest, secretValues, runtimeEnvironment)
					: null,
			locale:
				manifest.locale && hostedTarget
					? managedLocaleBlock(manifest.locale)
					: (manifest.locale?.timezone ?? null),
			mcp: hostedTarget ? hostedMcpIntent(manifest) : null,
			provider: providerProjectionRevision,
			skills: hostedBundledSkillProjection(manifest, runtime),
		},
		runtime: desiredProgram,
		secretValues: scopedSecretValues(secretValues, runtimeSecretRefs),
	});
}

function runtimeServiceProgramRevision(program: RuntimeSystemdUserProgram): string {
	return revisionHash({
		runtime: program.runtime,
		service: program.service,
		command: program.command,
		args: program.args,
		cwd: program.cwd,
		env: program.env,
	});
}

export function daemonProgramRevision(manifest: RuntimeManifest): string {
	return revisionHash({
		clawdiCli: manifest.clawdiCli ?? null,
		controlPlane: manifest.controlPlane,
		liveSync: manifest.liveSync ?? null,
	});
}

interface RuntimeSystemdUserProgram {
	runtime: RuntimeName;
	service: RuntimeServiceName | null;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	resolvedSecretEnv: Record<string, string>;
}

interface RuntimeEgressSystemdProgram {
	profileBundlePath: string;
	envFilePath: string;
	transparentPort: number;
	addonPath: string;
	addonSha256: string;
	engine: Extract<RuntimeMitmproxyEnsureResult, { status: "ready" }>;
	systemCaBundle: string;
	secretFilePath: string | null;
}

interface RuntimeEgressIdentity {
	runtimeUid: number;
	runtimeGid: number;
	egressUid: number;
	egressGid: number;
}

function runtimeEgressSystemdProgram(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	profileBundlePath: string | null,
	secretFilePath: string | null,
	engine: RuntimeMitmproxyEnsureResult | null,
	addon: { path: string; sha256: string } | null,
): RuntimeEgressSystemdProgram | null {
	if (!profileBundlePath) return null;
	if (engine?.status !== "ready") return null;
	if (!addon) return null;
	const port = 18_080 + (hashToUInt16(`${manifest.instanceId}:${paths.serviceStateRoot}`) % 20_000);
	return {
		profileBundlePath,
		envFilePath: paths.egressTransparentEnv,
		transparentPort: port,
		addonPath: addon.path,
		addonSha256: addon.sha256,
		engine,
		systemCaBundle: paths.egressSystemCaFile,
		secretFilePath,
	};
}

function buildRuntimeSystemdUserProgram(input: {
	config: RuntimeRunConfig;
	paths: RuntimePaths;
	secretValues: Record<string, string> | undefined;
	runtimeEnvironment: RuntimeEnvironmentAuthority;
	egress: RuntimeEgressSystemdProgram | null;
}): RuntimeSystemdUserProgram | null {
	if (!input.config.enabled) return null;

	const currentPath = withoutPathEntry(
		withoutPathEntry(runtimeSystemdPath(input.paths), runtimeManagedBinDir(input.paths)),
		dirname(input.paths.cliManagedBin),
	);
	const pathPrefix = input.config.prependPath.join(":");
	const env: Record<string, string> = {
		...input.config.env,
		PATH: pathPrefix ? [pathPrefix, currentPath].filter(Boolean).join(":") : currentPath,
	};
	const resolvedSecretEnv: Record<string, string> = {};
	for (const [envName, ref] of Object.entries(input.config.secretEnv)) {
		const value = runtimeSecretValue(input.secretValues ?? {}, ref, input.runtimeEnvironment);
		if (!value) {
			throw new Error(`Runtime secret ${ref} for ${envName} is unavailable.`);
		}
		env[envName] = value;
		resolvedSecretEnv[envName] = value;
	}
	if (input.egress) {
		applyEgressTransparentRuntimeEnv(env, { caFile: input.egress.systemCaBundle });
	}

	const command =
		input.config.commandPath && existsSync(input.config.commandPath)
			? input.config.commandPath
			: input.config.command;

	return {
		runtime: input.config.runtime,
		service: input.config.service,
		command,
		args: input.config.defaultArgs,
		cwd: input.config.cwd ?? input.paths.workspaceRoot,
		env,
		resolvedSecretEnv,
	};
}

export function runtimeSecretValue(
	secrets: Record<string, string>,
	ref: string,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): string | null {
	return resolveRuntimeSecretValue(secrets, ref, runtimeEnvironment);
}

function hashToUInt16(input: string): number {
	return createHash("sha256").update(input).digest().readUInt16BE(0);
}

export function runtimeSidecarProgramRevision(
	manifest: RuntimeManifest,
	egressProgram: RuntimeEgressSystemdProgram | null = null,
	egressIdentity: RuntimeEgressIdentity | null = null,
): string {
	if (egressProgram && !egressIdentity) {
		throw new Error("runtime sidecar egress revision requires the configured numeric identity");
	}
	return revisionHash({
		runtimeSidecar: "hosted-runtime-sidecar-v4",
		instanceId: manifest.instanceId,
		egressProfiles: manifest.egressProfiles ?? null,
		egress: egressProgram
			? {
					transparentPort: egressProgram.transparentPort,
					profileBundlePath: egressProgram.profileBundlePath,
					secretFilePath: egressProgram.secretFilePath,
					engine: egressProgram.engine,
					addonSha256: egressProgram.addonSha256,
					transport: TRANSPARENT_EGRESS_TRANSPORT_VERSION,
					identity: egressIdentity,
				}
			: null,
	});
}

function runtimeUserUid(runtimeUser: string): number {
	const explicit = Number.parseInt(process.env.CLAWDI_RUNTIME_UID?.trim() ?? "", 10);
	if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 4_294_967_295) {
		return explicit;
	}
	return systemUserUid(runtimeUser, runtimeUser === "clawdi" ? 10_001 : null);
}

function runtimeEgressUid(): number {
	return positiveLinuxIdEnv("CLAWDI_EGRESS_UID", 10_002);
}

function runtimeEgressGid(): number {
	return positiveLinuxIdEnv("CLAWDI_EGRESS_GID", 10_002);
}

function positiveLinuxIdEnv(key: string, fallback: number): number {
	const raw = process.env[key]?.trim();
	if (!raw) return fallback;
	return parsePositiveLinuxId(raw, key);
}

function systemUserUid(user: string, fallback: number | null): number {
	const resolved = spawnSync("id", ["-u", user], { encoding: "utf8" });
	if (resolved.status === 0) {
		const uid = Number.parseInt(resolved.stdout.trim(), 10);
		if (Number.isInteger(uid) && uid >= 0 && uid <= 4_294_967_295) return uid;
	}
	if (fallback !== null) return fallback;
	throw new Error(`could not resolve uid for ${user}`);
}

function runtimeSystemdProgramName(program: RuntimeSystemdUserProgram): string {
	const officialName = officialRuntimeSystemdProgramName(program);
	if (officialName) return officialName;
	if (!program.service) return `clawdi-${systemdUnitNameSegment(program.runtime)}`;
	return runtimeServiceProgramName(program.runtime, program.service);
}

function officialRuntimeSystemdProgramName(program: RuntimeSystemdUserProgram): string | null {
	return officialRuntimeServiceDescriptorForProgram(program)?.programName ?? null;
}

function runtimeSystemdProgramRevision(
	manifest: RuntimeManifest,
	program: RuntimeSystemdUserProgram,
	secretValues: Record<string, string> | undefined,
	providerProjectionRevisions: Partial<Record<string, string | null>> = {},
	runtimeEnvironment: RuntimeEnvironmentAuthority = projectedRuntimeEnvironment({}),
): string {
	if (program.service) return runtimeServiceProgramRevision(program);
	return runtimeProgramRevision(
		manifest,
		program.runtime,
		secretValues,
		providerProjectionRevisions[program.runtime] ?? null,
		runtimeEnvironment,
	);
}

function shouldRunRuntime(runtime: string, manifest: RuntimeManifest): boolean {
	const desired = manifest.runtimes[runtime];
	if (!desired?.enabled) return false;
	return isSupportedRuntimeName(runtime) || Boolean(desired.run?.command?.trim());
}

function runtimeServiceProgramName(runtime: string, service: string): string {
	const official = OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
		(descriptor) => descriptor.runtime === runtime && descriptor.service === service,
	);
	if (official) return official.programName;
	if (runtime === "hermes" && service === "dashboard") return "clawdi-hermes-dashboard";
	return `clawdi-${systemdUnitNameSegment(runtime)}-${systemdUnitNameSegment(service)}`;
}

function systemdUnitNameSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function runtimeSystemdPath(paths: RuntimePaths): string {
	return [
		join(paths.serviceStateRoot, "bin"),
		join(paths.userHome, ".local", "bin"),
		join(paths.userHome, ".openclaw", "bin"),
		process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	].join(":");
}

function systemdUnitFileName(name: string): string {
	return `${systemdUnitNameSegment(name)}.service`;
}

function systemdDropInFilePath(paths: RuntimePaths, unitName: string): string {
	return join(paths.systemdUserRoot, `${systemdUnitFileName(unitName)}.d`, "10-clawdi-hosted.conf");
}

function systemdQuote(value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new Error("systemd unit values must be single-line strings");
	}
	return `"${value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/%/g, "%%")
		.replace(/\$/g, "$$")}"`;
}

function systemdExec(command: string, args: string[]): string {
	return [command, ...args].map(systemdQuote).join(" ");
}

function systemdPath(value: string): string {
	if (!isAbsolute(value)) {
		throw new Error(`systemd unit paths must be absolute: ${value}`);
	}
	if (/[\r\n]/.test(value)) {
		throw new Error("systemd unit paths must be single-line strings");
	}
	return value
		.replace(/\\/g, "\\\\")
		.replace(/%/g, "%%")
		.replace(/ /g, "\\x20")
		.replace(/\t/g, "\\x09");
}

function systemdUnitEnvironmentLines(values: Record<string, string>): string[] {
	return Object.entries(values).map(
		([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`,
	);
}

function systemdEnvironmentFilePath(paths: RuntimePaths, unitName: string): string {
	return join(paths.systemdEnvRoot, `${systemdUnitFileName(unitName)}.env`);
}

function systemdEnvironmentFileQuote(value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new Error("systemd environment files only support single-line values");
	}
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type OfficialRuntimeServiceDescriptor = {
	runtime: RuntimeName;
	programName: string;
	command: string;
	installArgs: string[];
	uninstallArgs: string[];
	// Manifest `services` key the official unit corresponds to; used for
	// program naming even when such an entry is not official for the runtime.
	service: string;
	// Extra env projected into the unit's environment file.
	unitEnv?: (unitName: string) => Record<string, string>;
	// Which desired programs the official unit covers. Deliberately
	// asymmetric: openclaw's default program is its gateway, while hermes may
	// express the gateway as the default program or an explicit
	// `services.gateway` entry.
	matchesProgram: (program: RuntimeSystemdUserProgram) => boolean;
};

const OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS: OfficialRuntimeServiceDescriptor[] = [
	{
		runtime: "openclaw",
		programName: "openclaw-gateway",
		command: "openclaw",
		installArgs: ["gateway", "install", "--force", "--json"],
		uninstallArgs: ["gateway", "uninstall"],
		service: "gateway",
		unitEnv: (unitName) => ({ OPENCLAW_SYSTEMD_UNIT: unitName }),
		matchesProgram: (program) => !program.service,
	},
	{
		runtime: "hermes",
		programName: "hermes-gateway",
		command: "hermes",
		installArgs: ["gateway", "install", "--force"],
		uninstallArgs: ["gateway", "uninstall"],
		service: "gateway",
		matchesProgram: (program) => (program.service ?? program.args[0] ?? "") === "gateway",
	},
];

function officialRuntimeServiceDescriptorForProgram(
	program: RuntimeSystemdUserProgram,
): OfficialRuntimeServiceDescriptor | null {
	return (
		OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
			(descriptor) => descriptor.runtime === program.runtime && descriptor.matchesProgram(program),
		) ?? null
	);
}

function officialRuntimeServiceDescriptorForUnit(
	unitName: string,
): OfficialRuntimeServiceDescriptor | null {
	return (
		OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
			(descriptor) => systemdUnitFileName(descriptor.programName) === unitName,
		) ?? null
	);
}

function officialRuntimeServiceCommand(
	descriptor: OfficialRuntimeServiceDescriptor,
	paths: RuntimePaths,
): string {
	const commandPath = runtimeCommandPath(descriptor.runtime, paths.userHome);
	return commandPath && executableExists(commandPath) ? commandPath : descriptor.command;
}

function writeSystemdEnvironmentFile(input: {
	paths: RuntimePaths;
	name: string;
	owner: "root" | "runtime-user";
	env: Record<string, string>;
}): string {
	makeRootReadableDir(dirname(input.paths.systemdEnvRoot));
	makeRootReadableDir(input.paths.systemdEnvRoot);
	const path = systemdEnvironmentFilePath(input.paths, input.name);
	const lines = Object.entries(input.env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				throw new Error(`invalid systemd environment key: ${key}`);
			}
			return `${key}=${systemdEnvironmentFileQuote(value)}`;
		});
	writePrivateFileAtomic(path, `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n${lines.join("\n")}\n`, {
		mode: 0o600,
		dirMode: 0o755,
	});
	if (input.owner === "runtime-user") makeRuntimeUserOwned(path);
	else makeRootOwned(path);
	return path;
}

function writeSystemdProgramEnvironment(input: {
	paths: RuntimePaths;
	name: string;
	owner: "root" | "runtime-user";
	env: Record<string, string>;
	revisionEnv?: Record<string, string>;
}): { envFile: string; envRevision: string } {
	return {
		envFile: writeSystemdEnvironmentFile(input),
		envRevision: revisionHash({
			systemdEnvironmentFile: "v1",
			env: input.revisionEnv ?? input.env,
		}),
	};
}

function writeSystemdUnit(input: {
	root: string;
	owner: "root" | "runtime-user";
	paths: RuntimePaths;
	name: string;
	description: string;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	revisionEnv?: Record<string, string>;
	unitEnv?: Record<string, string>;
	serviceType?: "simple" | "oneshot" | "notify";
	restart?: boolean;
	extraUnitLines?: string[];
	extraServiceLines?: string[];
	wantedBy: "multi-user.target" | "default.target";
}): string {
	const path = join(input.root, systemdUnitFileName(input.name));
	const { envFile, envRevision } = writeSystemdProgramEnvironment({
		paths: input.paths,
		name: input.name,
		owner: input.owner,
		env: input.env,
		revisionEnv: input.revisionEnv,
	});
	const lines = [
		GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
		"[Unit]",
		`Description=${input.description}`,
		...(input.owner === "runtime-user"
			? [
					"# The environment file is regenerated by convergence each boot; this unit must not start before it exists.",
					`ConditionPathExists=${systemdPath(envFile)}`,
				]
			: []),
		...(input.extraUnitLines ?? []),
		"",
		"[Service]",
		`# ClawdiEnvironmentRevision=${envRevision}`,
		`Type=${input.serviceType ?? "simple"}`,
		`WorkingDirectory=${systemdPath(input.cwd)}`,
		...(input.unitEnv ? systemdUnitEnvironmentLines(input.unitEnv) : []),
		...(input.extraServiceLines ?? []),
		`EnvironmentFile=${systemdPath(envFile)}`,
		`ExecStart=${systemdExec(input.command, input.args)}`,
		...(input.restart === false
			? []
			: ["Restart=always", "RestartSec=2", "KillMode=mixed", "TimeoutStopSec=30"]),
		"",
		"[Install]",
		`WantedBy=${input.wantedBy}`,
		"",
	];
	const writeUnitFile = (): string => {
		mkdirSync(input.root, { recursive: true });
		if (input.owner === "runtime-user") makeRuntimeUserOwned(input.root);
		writePrivateFileAtomic(path, `${lines.join("\n")}`, { mode: 0o644, dirMode: 0o755 });
		if (input.owner === "runtime-user") makeRuntimeUserOwned(path);
		else makeRootOwned(path);
		return path;
	};
	return input.owner === "runtime-user"
		? withRuntimeUserFileAccess(writeUnitFile)
		: writeUnitFile();
}

function writeSystemdSystemUnit(
	input: Omit<Parameters<typeof writeSystemdUnit>[0], "root" | "owner" | "wantedBy">,
): string {
	return writeSystemdUnit({
		...input,
		root: input.paths.systemdSystemRoot,
		owner: "root",
		wantedBy: "multi-user.target",
	});
}

function writeSystemdUserUnit(
	input: Omit<Parameters<typeof writeSystemdUnit>[0], "root" | "owner" | "wantedBy">,
): string {
	return writeSystemdUnit({
		...input,
		root: input.paths.systemdUserRoot,
		owner: "runtime-user",
		extraServiceLines: [
			'Environment="XDG_RUNTIME_DIR=%t"',
			'Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"',
			...(input.extraServiceLines ?? []),
		],
		wantedBy: "default.target",
	});
}

function writeSystemdUserDropIn(input: {
	paths: RuntimePaths;
	name: string;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}): string {
	const unitName = systemdUnitFileName(input.name);
	const { envFile, envRevision } = writeSystemdProgramEnvironment({
		paths: input.paths,
		name: input.name,
		owner: "runtime-user",
		env: input.env,
	});
	const path = systemdDropInFilePath(input.paths, input.name);
	const lines = [
		GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
		"# ClawdiHostedRuntimeDropIn=v1",
		"# The base unit is generated by the runtime's official service installer.",
		"[Unit]",
		"# The environment file is regenerated by convergence each boot; this unit must not start before it exists.",
		`ConditionPathExists=${systemdPath(envFile)}`,
		"",
		"[Service]",
		`# ClawdiEnvironmentRevision=${envRevision}`,
		`WorkingDirectory=${systemdPath(input.cwd)}`,
		'Environment="XDG_RUNTIME_DIR=%t"',
		'Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"',
		`EnvironmentFile=${systemdPath(envFile)}`,
		"ExecStart=",
		`ExecStart=${systemdExec(input.command, input.args)}`,
		"",
	];
	return withRuntimeUserFileAccess(() => {
		removeGeneratedRuntimeBaseUnit(input.paths, unitName);
		mkdirSync(dirname(path), { recursive: true });
		makeRuntimeUserOwned(dirname(path));
		writePrivateFileAtomic(path, `${lines.join("\n")}`, { mode: 0o644, dirMode: 0o755 });
		makeRuntimeUserOwned(path);
		return join(input.paths.systemdUserRoot, unitName);
	});
}

function removeGeneratedRuntimeBaseUnit(paths: RuntimePaths, unitName: string): void {
	const path = join(paths.systemdUserRoot, unitName);
	if (!isGeneratedSystemdFile(path)) return;
	rmSync(path, { force: true });
}

function officialRuntimeServiceInstallArgs(program: RuntimeSystemdUserProgram): string[] | null {
	return officialRuntimeServiceDescriptorForProgram(program)?.installArgs ?? null;
}

function shouldInstallOfficialRuntimeServices(): boolean {
	// Official gateway installers need a live systemd user bus to converge.
	// When the systemd apply phase is explicitly disabled (headless CI and
	// smoke containers without systemd), fall back to writing complete
	// clawdi-* units instead of failing the whole convergence; the next
	// convergence under real systemd retries the official install.
	const applyOverride = process.env.CLAWDI_SYSTEMD_APPLY?.trim().toLowerCase();
	if (applyOverride === "0" || applyOverride === "false") return false;
	const override = process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES?.trim().toLowerCase();
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	return runningAsRoot();
}

function commandResolvable(command: string): boolean {
	return isAbsolute(command) ? executableExists(command) : commandExists(command);
}

function installOfficialRuntimeUserService(
	program: RuntimeSystemdUserProgram,
	paths: RuntimePaths,
): string | null {
	const descriptor = officialRuntimeServiceDescriptorForProgram(program);
	if (!descriptor || !shouldInstallOfficialRuntimeServices()) return null;
	const args = descriptor.installArgs;
	if (!commandResolvable(program.command)) {
		return `official ${runtimeSystemdProgramName(program)} service installer command is unavailable: ${program.command}`;
	}
	try {
		ensureConfiguredRuntimeUserManagerReady();
		resetFailedRuntimeUserService(runtimeSystemdProgramName(program), paths, program.cwd);
		runRuntimeUserCommand(program.command, args, "", paths.userHome, program.cwd);
		return null;
	} catch (error) {
		return `official ${runtimeSystemdProgramName(program)} service install failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
}

function resetFailedRuntimeUserService(name: string, paths: RuntimePaths, cwd: string): void {
	try {
		runRuntimeUserCommand(
			process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl",
			["--user", "reset-failed", systemdUnitFileName(name)],
			"",
			paths.userHome,
			cwd,
		);
	} catch {
		// The unit may not exist yet; reset-failed must never block convergence.
	}
}

function reloadRuntimeUserManager(paths: RuntimePaths, cwd: string): void {
	try {
		ensureConfiguredRuntimeUserManagerReady();
		runRuntimeUserCommand(
			process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl",
			["--user", "daemon-reload"],
			"",
			paths.userHome,
			cwd,
		);
	} catch {
		// Best-effort: environments without a reachable user manager (unit tests,
		// non-hosted hosts) must not fail convergence, and official installers
		// perform their own daemon-reload after writing the base unit.
	}
}

function uninstallOfficialRuntimeUserService(input: {
	unitName: string;
	paths: RuntimePaths;
	workspaceRoot: string;
}): string | null {
	const descriptor = officialRuntimeServiceDescriptorForUnit(input.unitName);
	if (!descriptor || !shouldInstallOfficialRuntimeServices()) return null;
	const command = officialRuntimeServiceCommand(descriptor, input.paths);
	if (!commandResolvable(command)) {
		return `official ${input.unitName} uninstaller command is unavailable: ${command}`;
	}
	try {
		ensureConfiguredRuntimeUserManagerReady();
		runRuntimeUserCommand(
			command,
			descriptor.uninstallArgs,
			"",
			input.paths.userHome,
			input.workspaceRoot,
		);
		return null;
	} catch (error) {
		return `official ${input.unitName} uninstall failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
}

function systemdUnitNameFromPath(unitPath: string): string {
	return unitPath.split("/").at(-1) ?? "";
}

function staleOfficialRuntimeUserServices(paths: RuntimePaths, writtenUnits: string[]): string[] {
	if (!existsSync(paths.systemdUserRoot)) return [];
	const writtenNames = new Set(writtenUnits.map(systemdUnitNameFromPath));
	const stale: string[] = [];
	for (const entry of readdirSync(paths.systemdUserRoot)) {
		if (!entry.endsWith(".service.d")) continue;
		const unitName = entry.slice(0, -".d".length);
		if (writtenNames.has(unitName)) continue;
		if (!officialRuntimeServiceDescriptorForUnit(unitName)) continue;
		const dropInPath = join(paths.systemdUserRoot, entry, "10-clawdi-hosted.conf");
		if (!isGeneratedSystemdFile(dropInPath)) continue;
		const baseUnitPath = join(paths.systemdUserRoot, unitName);
		if (!existsSync(baseUnitPath) || isGeneratedSystemdFile(baseUnitPath)) continue;
		stale.push(unitName);
	}
	return stale.sort();
}

function removeStaleSystemdUserUnits(paths: RuntimePaths, writtenUnits: string[]): void {
	withRuntimeUserFileAccess(() => {
		if (!existsSync(paths.systemdUserRoot)) return;
		const writtenNames = new Set(writtenUnits.map(systemdUnitNameFromPath));
		for (const entry of readdirSync(paths.systemdUserRoot)) {
			if (!entry.endsWith(".service")) continue;
			const path = join(paths.systemdUserRoot, entry);
			if (!entry.startsWith("clawdi-") && !isGeneratedSystemdFile(path)) continue;
			if (writtenNames.has(entry)) continue;
			rmSync(path, { force: true });
		}
		const wantsDir = join(paths.systemdUserRoot, "default.target.wants");
		if (existsSync(wantsDir)) {
			for (const entry of readdirSync(wantsDir)) {
				if (!entry.endsWith(".service")) continue;
				const unitPath = join(paths.systemdUserRoot, entry);
				if (!entry.startsWith("clawdi-") && !isGeneratedSystemdFile(unitPath)) continue;
				if (writtenNames.has(entry)) continue;
				rmSync(join(wantsDir, entry), { force: true });
			}
		}
		for (const entry of readdirSync(paths.systemdUserRoot)) {
			if (!entry.endsWith(".service.d")) continue;
			const unitName = entry.slice(0, -".d".length);
			const dropInPath = join(paths.systemdUserRoot, entry, "10-clawdi-hosted.conf");
			if (!isGeneratedSystemdFile(dropInPath)) continue;
			if (writtenNames.has(unitName)) continue;
			rmSync(dropInPath, { force: true });
			try {
				if (readdirSync(dirname(dropInPath)).length === 0)
					rmSync(dirname(dropInPath), { force: true });
			} catch {
				// Best effort cleanup only.
			}
		}
	});
}

function isGeneratedSystemdFile(path: string): boolean {
	try {
		return isGeneratedRuntimeSystemdFile(readFileSync(path, "utf-8"));
	} catch {
		return false;
	}
}

function removeStaleSystemdSystemUnits(paths: RuntimePaths, writtenUnits: string[]): void {
	if (!existsSync(paths.systemdSystemRoot)) return;
	const managed = new Set([
		"clawdi-runtime-watch.service",
		"clawdi-daemon.service",
		"clawdi-runtime-sidecar.service",
	]);
	const writtenNames = new Set(writtenUnits.map(systemdUnitNameFromPath));
	for (const entry of readdirSync(paths.systemdSystemRoot)) {
		if (!managed.has(entry) || writtenNames.has(entry)) continue;
		rmSync(join(paths.systemdSystemRoot, entry), { force: true });
	}
}

function removeStaleSystemdEnvironmentFiles(paths: RuntimePaths, writtenUnits: string[]): void {
	if (!existsSync(paths.systemdEnvRoot)) return;
	const writtenNames = new Set(writtenUnits.map((unit) => `${systemdUnitNameFromPath(unit)}.env`));
	for (const entry of readdirSync(paths.systemdEnvRoot)) {
		if (!entry.endsWith(".service.env")) continue;
		const path = join(paths.systemdEnvRoot, entry);
		if (!entry.startsWith("clawdi-") && !isGeneratedSystemdFile(path)) continue;
		if (writtenNames.has(entry)) continue;
		rmSync(path, { force: true });
	}
}

function runtimeManifestUrlEnv(
	sourcePath: string,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): string {
	if (/^https?:\/\//i.test(sourcePath)) return sourcePath;
	return (
		runtimeSecretValue(
			secretValues ?? {},
			"env://CLAWDI_RUNTIME_MANIFEST_URL",
			runtimeEnvironment,
		) ?? ""
	);
}

function runtimeSystemdCommonEnvironment(
	sourcePath: string,
	paths: RuntimePaths,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): Record<string, string> {
	const runtimeUser =
		runtimeSecretValue(secretValues ?? {}, "env://CLAWDI_RUNTIME_USER", runtimeEnvironment) ??
		"clawdi";
	const environment: Record<string, string> = {
		HOME: paths.userHome,
		CLAWDI_RUNTIME_MODE:
			runtimeSecretValue(secretValues ?? {}, "env://CLAWDI_RUNTIME_MODE", runtimeEnvironment) ??
			"hosted",
		CLAWDI_RUNTIME_AUTH_ENV:
			runtimeSecretValue(secretValues ?? {}, "env://CLAWDI_RUNTIME_AUTH_ENV", runtimeEnvironment) ??
			"",
		CLAWDI_RUNTIME_USER: runtimeUser,
		CLAWDI_SERVICE_STATE_DIR: paths.serviceStateRoot,
		CLAWDI_RUN_DIR: paths.runRoot,
		CLAWDI_RUNTIME_MANIFEST_URL: runtimeManifestUrlEnv(
			sourcePath,
			secretValues,
			runtimeEnvironment,
		),
		PATH: runtimeSystemdPath(paths),
	};
	return environment;
}

function runtimeWatchSecretEnvironment(
	programs: RuntimeSystemdUserProgram[],
): Record<string, string> {
	const retained = new Map<string, { value: string; program: string }>();
	for (const program of [...programs].sort((a, b) =>
		runtimeSystemdProgramName(a).localeCompare(runtimeSystemdProgramName(b)),
	)) {
		const programName = runtimeSystemdProgramName(program);
		for (const [envName, value] of Object.entries(program.resolvedSecretEnv).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			const existing = retained.get(envName);
			if (existing && existing.value !== value) {
				throw new Error(
					`Runtime watch secret environment ${envName} conflicts between ${existing.program} and ${programName}.`,
				);
			}
			retained.set(envName, { value, program: existing?.program ?? programName });
		}
	}
	return Object.fromEntries([...retained].map(([envName, entry]) => [envName, entry.value]));
}

function writeRuntimeSystemdUserProgram(input: {
	program: RuntimeSystemdUserProgram;
	commonEnvironment: Record<string, string>;
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	secretValues: Record<string, string> | undefined;
	runtimeEnvironment: RuntimeEnvironmentAuthority;
	providerProjectionRevisions: Partial<Record<string, string | null>>;
}): string {
	const { program } = input;
	const name = runtimeSystemdProgramName(program);
	const unitName = systemdUnitFileName(name);
	const env = {
		...input.commonEnvironment,
		...program.env,
		...(input.manifest.locale ? { TZ: input.manifest.locale.timezone } : {}),
		CLAWDI_AUTH_TOKEN: "",
		CLAWDI_RUNTIME_REV: runtimeSystemdProgramRevision(
			input.manifest,
			program,
			input.secretValues,
			input.providerProjectionRevisions,
			input.runtimeEnvironment,
		),
		...(officialRuntimeServiceDescriptorForProgram(program)?.unitEnv?.(unitName) ?? {}),
	};
	if (officialRuntimeServiceInstallArgs(program)) {
		return writeSystemdUserDropIn({
			paths: input.paths,
			name,
			command: program.command,
			args: program.args,
			cwd: program.cwd,
			env,
		});
	}
	return writeSystemdUserUnit({
		paths: input.paths,
		name,
		description: `Clawdi hosted ${program.runtime}${program.service ? ` ${program.service}` : ""}`,
		command: program.command,
		args: program.args,
		cwd: program.cwd,
		env,
	});
}

function officialRuntimeSystemdPrograms(
	programs: RuntimeSystemdUserProgram[],
): RuntimeSystemdUserProgram[] {
	const byServiceName = new Map<string, RuntimeSystemdUserProgram>();
	for (const program of programs) {
		const serviceName = officialRuntimeSystemdProgramName(program);
		if (serviceName) byServiceName.set(serviceName, program);
	}
	return [...byServiceName.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, program]) => program);
}

function writeSystemdUnits(
	runtimePrograms: RuntimeSystemdUserProgram[],
	egressProgram: RuntimeEgressSystemdProgram | null,
	egressIdentity: RuntimeEgressIdentity | null,
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	workspaceRoot: string,
	daemonAuthTokenFile: string | null,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
	providerProjectionRevisions: Partial<Record<string, string | null>>,
	commonEnvironment: Record<string, string>,
	applyContext: RuntimeApplyContext | undefined,
): { systemUnits: string[]; userUnits: string[]; egressSidecarActive: boolean } {
	const runtimeUser = commonEnvironment.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	const systemUnits: string[] = [];
	const shouldRunEgress = egressProgram !== null && runtimePrograms.length > 0;
	const activeEgressProgram = shouldRunEgress ? egressProgram : null;
	const activeEgressIdentity = shouldRunEgress ? egressIdentity : null;
	const userUnits: string[] = [];
	const runtimeUid = shouldRunEgress ? runtimeUserUid(runtimeUser) : null;
	const applyIdentityEnvironment =
		applyContext === undefined
			? runtimeApplyIdentityServiceEnvironment()
			: runtimeApplyContextServiceEnvironment(applyContext);
	if (daemonAuthTokenFile) {
		const watchSecretEnvironment = runtimeWatchSecretEnvironment(runtimePrograms);
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-runtime-watch",
				description: "Clawdi hosted runtime desired-state watcher",
				command: paths.cliManagedBin,
				args: ["runtime", "watch"],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					...applyIdentityEnvironment,
					...watchSecretEnvironment,
					CLAWDI_AUTH_TOKEN: "",
				},
				// Unit files are 0644. Hash only secret destination names into their
				// revision so the unit cannot become an offline verifier for values.
				// The watcher resolves values from the atomic apply-context file on
				// each tick; keep secret bytes out of its public revision material.
				revisionEnv: {
					...commonEnvironment,
					...applyIdentityEnvironment,
					...Object.fromEntries(Object.keys(watchSecretEnvironment).map((name) => [name, ""])),
					CLAWDI_AUTH_TOKEN: "",
				},
			}),
		);
	}

	if (daemonAuthTokenFile) {
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-daemon",
				description: "Clawdi hosted runtime daemon",
				command: paths.cliManagedBin,
				args: ["daemon", "run", "--auth-token-file", daemonAuthTokenFile],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					...applyIdentityEnvironment,
					CLAWDI_ENVIRONMENT_ID: manifest.environmentId,
					CLAWDI_SERVE_MODE: "container",
					CLAWDI_API_URL: manifest.controlPlane.apiUrl,
					CLAWDI_NO_AUTO_UPDATE: "1",
					CLAWDI_NO_UPDATE_CHECK: "1",
					CLAWDI_RUNTIME_REV: daemonProgramRevision(manifest),
				},
			}),
		);
	}

	if (activeEgressProgram) {
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-runtime-sidecar",
				description: "Clawdi hosted runtime sidecar",
				command: paths.cliManagedBin,
				args: ["runtime", "sidecar"],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					CLAWDI_AUTH_TOKEN: "",
					CLAWDI_EGRESS_ENV_FILE: activeEgressProgram.envFilePath,
					CLAWDI_RUNTIME_REV: runtimeSidecarProgramRevision(
						manifest,
						activeEgressProgram,
						activeEgressIdentity,
					),
				},
				serviceType: "notify",
				extraUnitLines: runtimeUid === null ? undefined : [`Before=user@${runtimeUid}.service`],
				extraServiceLines: ["NotifyAccess=main"],
			}),
		);
	}

	for (const program of runtimePrograms) {
		userUnits.push(
			writeRuntimeSystemdUserProgram({
				program,
				commonEnvironment,
				manifest,
				paths,
				secretValues,
				runtimeEnvironment,
				providerProjectionRevisions,
			}),
		);
	}

	removeStaleSystemdSystemUnits(paths, systemUnits);
	removeStaleSystemdUserUnits(paths, userUnits);
	removeStaleSystemdEnvironmentFiles(paths, [...systemUnits, ...userUnits]);
	return { systemUnits, userUnits, egressSidecarActive: shouldRunEgress };
}

function runtimeWorkspaceRoot(manifest: RuntimeManifest, paths: RuntimePaths): string {
	return manifest.workspaceRoot ?? paths.workspaceRoot;
}

function runtimeSecretValues(load: RuntimeManifestLoad): Record<string, string> | undefined {
	return load.secretValues && Object.keys(load.secretValues).length > 0
		? load.secretValues
		: undefined;
}

function validateRuntimeManifestPlan(manifest: RuntimeManifest, paths: RuntimePaths): void {
	const workspaceRoot = runtimeWorkspaceRoot(manifest, paths);
	const home = hostedRuntimeProjectionHome(manifest, paths);
	for (const name of HOSTED_RUNTIME_TARGETS) {
		validateHostedBundledSkillsPlan(name, manifest, home);
	}
	for (const [name, runtime] of Object.entries(manifest.runtimes)) {
		const runtimeName = runtimeNameSchema.parse(name);
		const providerPlaceholderEnv = runtime.enabled
			? hostedProviderPlaceholderEnv(manifest, name)
			: {};
		const providerSecretEnv = runtime.enabled ? hostedProviderSecretEnv(manifest, name) : {};
		assertNoProviderEnvOverlap(name, providerPlaceholderEnv, providerSecretEnv);
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
		if (!manifest.locale) continue;
		const block = managedLocaleBlock(manifest.locale);
		if (runtimeName === "openclaw") {
			nextManagedLocaleFileContent(join(workspaceRoot, "SOUL.md"), block);
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
	runtimeEnvironment: RuntimeEnvironmentAuthority;
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
		if (runtime.enabled && shouldRunRuntime(name, input.manifest)) {
			const program = buildRuntimeSystemdUserProgram({
				config: resolved.runtime,
				paths: input.paths,
				secretValues: input.secretValues,
				runtimeEnvironment: input.runtimeEnvironment,
				egress: input.egress,
			});
			if (program) programs.push(program);
		}
		for (const serviceRunConfig of resolved.services) {
			const program = buildRuntimeSystemdUserProgram({
				config: serviceRunConfig,
				paths: input.paths,
				secretValues: input.secretValues,
				runtimeEnvironment: input.runtimeEnvironment,
				egress: input.egress,
			});
			if (program) programs.push(program);
		}
	}
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
	const providerPlaceholderEnv = input.runtime.enabled
		? hostedProviderPlaceholderEnv(input.manifest, input.name)
		: {};
	const providerSecretEnv = input.runtime.enabled
		? hostedProviderSecretEnv(input.manifest, input.name)
		: {};
	assertNoProviderEnvOverlap(input.name, providerPlaceholderEnv, providerSecretEnv);
	const runtimeRunSettings = mergeRuntimeEnvWithProviderPlaceholders(
		input.name,
		input.runtime.run,
		providerPlaceholderEnv,
	);
	const secretEnv = input.runtime.enabled
		? mergeRuntimeSecretEnv(input.name, input.runtime, providerSecretEnv)
		: {};
	const secretFilePath =
		Object.keys(scopedSecretValues(input.secretValues, Object.values(secretEnv))).length > 0
			? runtimeSecretFilePath(input.paths, input.name)
			: null;
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

function validateRuntimeSystemdProgramsPlan(programs: RuntimeSystemdUserProgram[]): void {
	for (const program of programs) {
		systemdUnitFileName(runtimeSystemdProgramName(program));
		systemdPath(program.cwd);
		systemdExec(program.command, program.args);
		for (const [key, value] of Object.entries(program.env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				throw new Error(`invalid systemd environment key: ${key}`);
			}
			systemdEnvironmentFileQuote(value);
		}
	}
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
	workspaceRoot: string;
	secretValues: Record<string, string> | undefined;
	runtimeEnvironment: RuntimeEnvironmentAuthority;
	observations: Map<string, RuntimeInstallObservation>;
	previousProjectedProviderIds: Record<string, string[]>;
	managedModelOverrides?: ManagedGatewayModelOverrides;
}): void {
	const {
		manifest,
		paths,
		workspaceRoot,
		secretValues,
		runtimeEnvironment,
		observations,
		previousProjectedProviderIds,
		managedModelOverrides,
	} = input;
	const home = hostedRuntimeProjectionHome(manifest, paths);
	const localeBlock = manifest.locale ? managedLocaleBlock(manifest.locale) : null;
	if (localeBlock) {
		for (const name of Object.keys(manifest.runtimes)) {
			if (name === "openclaw") {
				nextManagedLocaleFileContent(join(workspaceRoot, "SOUL.md"), localeBlock);
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
		const providerPlaceholderEnv = runtime.enabled
			? hostedProviderPlaceholderEnv(manifest, name)
			: {};
		const providerSecretEnv = runtime.enabled ? hostedProviderSecretEnv(manifest, name) : {};
		assertNoProviderEnvOverlap(name, providerPlaceholderEnv, providerSecretEnv);
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

		const projectionInput = agentTargetProjectionInput(
			hostedAiProviderCatalog(manifest, name, {
				primaryModelOverride: managedModelOverrides?.primaryModels[name],
				managedModelsOverride: managedModelOverrides?.models[name],
			}),
		);
		assertHostedProviderProjectionMode(name, manifest, projectionInput);
		const configuredProjectionUnavailable =
			manifest.runtimes[name]?.providerMode === "configured" && !projectionInput;
		const projectionRequiresInstalledModelProbe =
			projectionInput?.catalog.providers.some((provider) => provider.managed_by === "clawdi") &&
			managedModelOverrides === undefined;
		if (name === "openclaw") {
			if (projectionInput && !projectionRequiresInstalledModelProbe) {
				buildOpenClawHostedProviderPatch(
					projectionInput,
					previousProjectedProviderIds.openclaw ?? [],
				);
			} else if (!configuredProjectionUnavailable) {
				buildOpenClawHostedProviderPatch(null, previousProjectedProviderIds.openclaw ?? []);
			}
			JSON.stringify(openClawGatewayHostedPatch(manifest, secretValues, runtimeEnvironment));
		}
		if (name === "hermes") {
			if (projectionInput && !projectionRequiresInstalledModelProbe) {
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
		if (channels && name === "hermes") {
			hermesConfig = renderHermesChannelConfig(
				hermesConfig,
				hermesManagedChannelsPatch(
					channels,
					manifest.controlPlane.apiUrl,
					manifest.projection?.channelCredentials,
				),
			);
		}
	}
	validateHostedMcpProjectionPlan(manifest, paths, observations);
	validateHostedChannelCredentialsPlan(manifest, secretValues, runtimeEnvironment, home);
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
		managedGatewayModelListFetcher?: ManagedGatewayModelListFetcher;
		egressEngineEnsureOptions?: EnsureRuntimeMitmproxyOptions;
		systemdApply?: RuntimeSystemdApplyHooks;
	} = {},
): RuntimeConvergenceResult {
	const { manifest } = load;
	const secretValues = runtimeSecretValues(load);
	const runtimeEnvironment = load.applyContext?.runtimeEnvironment;
	if (!runtimeEnvironment) {
		throw new Error("runtime manifest convergence requires an explicit apply context");
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
	const writtenRuntimeSecretIds = new Set<string>();
	const appliedState = readRuntimeAppliedState(paths);
	const previousInstallReceipts = readRuntimeInstallReceipts(paths);
	const installReceiptTargets: RuntimeInstallReceiptTargets = {
		officialServices: new Map(),
		channelPlugins: new Map(),
	};
	const previousProjectedProviderIds = appliedState?.projectedProviderIds ?? {};
	const projectedProviderIds: Record<string, string[]> = {};
	const runtimeEntries = Object.entries(manifest.runtimes).sort(([a], [b]) => a.localeCompare(b));
	const observations = new Map<string, RuntimeInstallObservation>();

	validateRuntimeManifestPlan(manifest, paths);
	for (const [name, runtime] of runtimeEntries) {
		const observation = planRuntimeInstallObservation(name, runtime, projectionHome);
		observations.set(name, observation);
		if (observation.error) installErrors.push(observation.error);
	}
	validateRuntimeProjectionPlan({
		manifest,
		paths,
		workspaceRoot,
		secretValues,
		runtimeEnvironment,
		observations,
		previousProjectedProviderIds,
	});
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
	const plannedRuntimePrograms = planRuntimeSystemdUserPrograms({
		manifest,
		paths,
		workspaceRoot,
		generatedAt,
		secretValues,
		runtimeEnvironment,
		observations,
		egressProfileBundlePath: plannedEgressProfileBundlePath,
		egress: null,
	});
	validateRuntimeSystemdProgramsPlan(plannedRuntimePrograms);
	observations.clear();
	for (const [name, runtime] of runtimeEntries) {
		const observation = observeRuntimeInstall(name, runtime, projectionHome);
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
	// Installers and probes may need a private scratch/log root. This is not
	// generation-owned live configuration and is created only after Plan succeeds.
	mkdirSync(paths.runRoot, { recursive: true });
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
	const managedModelOverrides = resolveManagedGatewayModelOverrides(
		manifest,
		enabledRuntimes,
		projectionHome,
		workspaceRoot,
		plannedEgressProfileBundlePath ? paths.egressSystemCaFile : null,
		opts.managedGatewayModelListFetcher ?? fetchManagedGatewayModelList,
	);
	validateRuntimeProjectionPlan({
		manifest,
		paths,
		workspaceRoot,
		secretValues,
		runtimeEnvironment,
		observations,
		previousProjectedProviderIds,
		managedModelOverrides,
	});

	const workspaceExistedBeforeApply = existsSync(workspaceRoot);
	const liveSnapshot = captureRuntimeLiveSnapshot(manifest, paths);
	let systemdActivationAttempted = false;
	let systemdActivationApplied = false;
	let restartDaemon = false;
	let desiredDaemonAuthTokenRevision: string | undefined;
	let restartEgressSidecar = false;
	let desiredEgressSidecarSecretRevision: string | undefined;
	let rollbackEgressSecretOverride: RuntimeEgressSecretMaterial | undefined;
	let rollbackEgressSecretRevision: string | undefined;
	let egressRollbackAuthorityVerified = true;
	try {
		const plannedUserUnits = plannedRuntimePrograms.map((program) =>
			join(paths.systemdUserRoot, systemdUnitFileName(runtimeSystemdProgramName(program))),
		);
		for (const unitName of staleOfficialRuntimeUserServices(paths, plannedUserUnits)) {
			const error = uninstallOfficialRuntimeUserService({ unitName, paths, workspaceRoot });
			if (error) throw new Error(error);
		}

		ensureRuntimeUserHome(paths.userHome);
		withRuntimeUserFileAccess(() => {
			mkdirSync(workspaceRoot, { recursive: true });
			makeRuntimeUserPrivateDir(paths.clawdiHome, paths.userHome);
			makeRuntimeUserOwned(workspaceRoot);
		});
		makeRootReadableDir(paths.installInventory);
		makeRootReadableDir(paths.projectionRoot);
		makeRootReadableDir(instanceRoot);
		makeRootReadableDir(semRoot);
		mkdirSync(paths.managedSecretRoot, { recursive: true });
		makeManagedSecretRoot(paths.managedSecretRoot);
		makeRootReadableDir(paths.egressProfileRoot);
		makeRootReadableDir(paths.egressRoot);
		makeEgressIdentityPrivateDir(paths.egressCaDir);
		makeRootReadableDir(dirname(paths.egressSystemCaFile));
		makeRuntimeUserPrivateDir(paths.egressScratchRoot, paths.userHome);

		let manifestLastGood: string | null = null;
		writeJsonFile(paths.managedConfig, {
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
		});
		writeJsonFile(paths.syncState, {
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
		});
		writeJsonFile(paths.instanceData, {
			schemaVersion: "clawdi.runtimeInstanceData.v1",
			generatedAt,
			deploymentId: manifest.deploymentId,
			environmentId: manifest.environmentId,
			instanceId: manifest.instanceId,
			generation: manifest.generation,
			locale: manifest.locale ?? null,
			controlPlane: manifest.controlPlane,
			workspaceRoot,
		});
		writeJsonFile(paths.sensitiveInstanceData, {
			schemaVersion: "clawdi.runtimeSensitiveInstanceData.v1",
			generatedAt,
			tokenSource: runtimeSecretValue(
				secretValues ?? {},
				RUNTIME_AUTH_TOKEN_SECRET_REF,
				runtimeEnvironment,
			)
				? "CLAWDI_AUTH_TOKEN"
				: load.source,
			token: "<redacted>",
		});

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
		const daemonAuthTokenFile = writeDaemonAuthToken(paths, runtimeEnvironment);
		const runtimeAuthToken = daemonAuthTokenFile ? readRuntimeAuthToken(paths) : null;
		if (runtimeAuthToken) {
			desiredDaemonAuthTokenRevision = daemonAuthTokenRevision(runtimeAuthToken);
			restartDaemon = desiredDaemonAuthTokenRevision !== appliedState?.daemonAuthTokenRevision;
		}
		writeSecretValues(secretValues, paths, egressSidecarOnlySecretRefs(manifest));
		try {
			withRuntimeUserFileAccess(() =>
				materializeHostedChannelCredentials(
					manifest,
					secretValues,
					runtimeEnvironment,
					projectionHome,
				),
			);
		} catch (error) {
			installErrors.push(
				`runtime channel credential materialization failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const egressSecretWrite = writeEgressSecretFile(
			manifest,
			secretValues,
			paths,
			runtimeEnvironment,
		);
		const egressSecretFile = egressSecretWrite.path;
		const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
		const egressSystemdProgram = runtimeEgressSystemdProgram(
			manifest,
			paths,
			egressProfileBundlePath,
			egressSecretFile,
			egressEngine,
			egressAddon,
		);
		const runtimeUid = egressSystemdProgram ? runtimeUserUid(runtimeUser) : 0;
		const runtimeGid = egressSystemdProgram ? runtimeUserGid(runtimeUser) : 0;
		const egressUid = egressSystemdProgram ? runtimeEgressUid() : 0;
		const egressGid = egressSystemdProgram ? runtimeEgressGid() : 0;
		const egressIdentity = egressSystemdProgram
			? { runtimeUid, runtimeGid, egressUid, egressGid }
			: null;
		const egressTransparentEnv = writeTransparentEgressEnvFile({
			program: egressSystemdProgram,
			paths,
			runtimeUser,
			runtimeUid,
			runtimeGid,
			egressUid,
			egressGid,
		});
		writeProviderHealthStatus(manifest, load.secretValues, runtimeEnvironment, paths);
		const liveSyncEnvironments = writeLiveSyncEnvironmentFiles(manifest, paths);
		const writtenRunConfigIds = new Set<string>();
		runtimeSystemdUserPrograms.push(
			...planRuntimeSystemdUserPrograms({
				manifest,
				paths,
				workspaceRoot,
				generatedAt,
				secretValues,
				runtimeEnvironment,
				observations,
				egressProfileBundlePath,
				egress: egressSystemdProgram,
			}),
		);
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
				managedModelOverrides,
			);
		}
		const commonSystemdEnvironment = runtimeSystemdCommonEnvironment(
			load.sourcePath,
			paths,
			secretValues,
			runtimeEnvironment,
		);
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
				applyHostedBundledSkills(name, observations.get(name), manifest, projectionHome);
			} catch (error) {
				installErrors.push(
					`runtime ${name} skill projection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
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

		for (const [name, runtime] of runtimeEntries) {
			const observation = observations.get(name);
			if (!observation) throw new Error(`runtime ${name} install observation is missing`);

			const inventoryPath = join(paths.installInventory, `${name}.json`);
			writeJsonFile(inventoryPath, {
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
			});
			installInventory.push(inventoryPath);

			const projectionPath = join(paths.projectionRoot, `${name}.json`);
			writeJsonFile(projectionPath, projectionPayload(name, manifest));
			projections.push(projectionPath);
			try {
				const localeFile = withRuntimeUserFileAccess(() =>
					applyHostedLocaleProjection(name, manifest, projectionHome, workspaceRoot),
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
					runtimeEnvironment,
					projectionHome,
					workspaceRoot,
					previousProjectedProviderIds[name] ?? [],
					managedModelOverrides,
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
			const runtimeProviderSecretFile = writeRuntimeProviderSecretFile(
				name,
				secretValues,
				resolved.secretEnv,
				paths,
			);
			if (runtimeProviderSecretFile !== resolved.secretFilePath) {
				throw new Error(`runtime ${name} secret projection did not match its resolved plan`);
			}
			if (runtimeProviderSecretFile) writtenRuntimeSecretIds.add(name);
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
				writePrivateFileAtomic(semaphorePath, `${generatedAt}\n`);
				instanceSemaphores.push(semaphorePath);
			}
		}

		const mcpProjection = join(paths.projectionRoot, "clawdi-mcp.json");
		if (hostedMcpProjectionDeclared(manifest) || manifest.projection?.skills !== undefined) {
			writeJsonFile(mcpProjection, projectionPayload("clawdi-mcp", manifest));
			projections.push(mcpProjection);
		} else {
			rmSync(mcpProjection, { force: true });
		}
		const systemdUnits = writeSystemdUnits(
			runtimeSystemdUserPrograms,
			egressSystemdProgram,
			egressIdentity,
			manifest,
			paths,
			workspaceRoot,
			daemonAuthTokenFile,
			secretValues,
			runtimeEnvironment,
			providerProjectionRevisions,
			commonSystemdEnvironment,
			load.applyContext,
		);
		const committedEgressSidecarSecretRevision = appliedState?.egressSidecarSecretRevision;
		if (systemdUnits.egressSidecarActive) {
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
				rollbackEgressSecretOverride = verifiedCommittedEgressSecretMaterial(paths) ?? undefined;
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
		const pendingOfficialServiceInstalls: Array<{
			program: RuntimeSystemdUserProgram;
			target: RuntimeInstallReceiptTarget;
		}> = [];
		if (shouldInstallOfficialRuntimeServices()) {
			for (const program of officialRuntimeSystemdPrograms(runtimeSystemdUserPrograms)) {
				const serviceName = runtimeSystemdProgramName(program);
				const key = systemdUnitFileName(serviceName);
				const desiredRevision = officialServiceDesiredRevision({ program });
				const currentRevision = () => officialServiceCurrentRevision(program, paths);
				const verifiedCurrentRevision = verifiedReceiptCurrentRevision(
					previousInstallReceipts?.officialServices[key],
					desiredRevision,
					currentRevision,
				);
				const target: RuntimeInstallReceiptTarget = {
					desiredRevision,
					currentRevision,
					expectedCurrentRevision: verifiedCurrentRevision,
				};
				installReceiptTargets.officialServices.set(key, target);
				if (verifiedCurrentRevision === null) {
					pendingOfficialServiceInstalls.push({ program, target });
				}
			}
		}
		if (
			pendingOfficialServiceInstalls.length > 0 &&
			systemdUnits.egressSidecarActive &&
			opts.systemdApply
		) {
			systemdActivationAttempted = true;
			const prerequisite = opts.systemdApply.activateEgressPrerequisite({
				restartDaemon,
				restartEgressSidecar,
			});
			if (!prerequisite.applied) {
				throw new Error("transparent-egress system prerequisites did not reach readiness");
			}
		}

		for (const { program, target } of pendingOfficialServiceInstalls) {
			reloadRuntimeUserManager(paths, paths.userHome);
			const error = installOfficialRuntimeUserService({ ...program, cwd: paths.userHome }, paths);
			if (error) throw new Error(error);
			target.expectedCurrentRevision = target.currentRevision();
		}

		const bootFinished = join(instanceRoot, "boot-finished");
		writePrivateFileAtomic(bootFinished, `${generatedAt}\n`);
		removeStaleRuntimeRunConfigs(writtenRunConfigIds, paths);
		removeStaleRuntimeSecretFiles(writtenRuntimeSecretIds, paths);
		if (opts.systemdApply) {
			systemdActivationAttempted = true;
			const activation = opts.systemdApply.activate({ restartDaemon, restartEgressSidecar });
			systemdActivationApplied = activation.applied;
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
			const daemonRevisionPreviouslyCommitted =
				desiredDaemonAuthTokenRevision !== undefined &&
				desiredDaemonAuthTokenRevision === appliedState?.daemonAuthTokenRevision;
			const egressRevisionPreviouslyCommitted =
				desiredEgressSidecarSecretRevision !== undefined &&
				desiredEgressSidecarSecretRevision === appliedState?.egressSidecarSecretRevision;
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
			commitRuntimeInstallReceipts(installReceiptTargets, paths);
		}
		return convergence;
	} catch (error) {
		const applyError = error instanceof Error ? error.message : String(error);
		let filesystemRollbackSucceeded = false;
		try {
			restoreRuntimeLiveSnapshot(liveSnapshot);
			if (rollbackEgressSecretOverride) {
				writeEgressSecretMaterial(rollbackEgressSecretOverride, paths);
			} else if (rollbackEgressSecretRevision) {
				writeEgressSecretMaterial(
					committedEgressSecretMaterial(paths, rollbackEgressSecretRevision),
					paths,
				);
			}
			filesystemRollbackSucceeded = true;
		} catch (rollbackError) {
			installErrors.push(
				`runtime filesystem rollback failed: ${
					rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
				}`,
			);
		}
		if (
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
		if (
			systemdActivationAttempted &&
			opts.systemdApply &&
			filesystemRollbackSucceeded &&
			egressRollbackAuthorityVerified
		) {
			try {
				opts.systemdApply.rollback({ restartDaemon, restartEgressSidecar });
			} catch (rollbackError) {
				installErrors.push(
					`runtime systemd rollback failed: ${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
		} else if (systemdActivationAttempted && opts.systemdApply) {
			installErrors.push(
				filesystemRollbackSucceeded
					? "runtime systemd rollback skipped because committed egress secret rollback authority could not be verified"
					: "runtime systemd rollback skipped because filesystem authority restoration failed",
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
