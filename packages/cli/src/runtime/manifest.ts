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
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AiProviderApiMode,
	AiProviderAuth,
	AiProviderCatalog,
	AiProviderModel,
	AiProviderType,
} from "@clawdi/shared";
import {
	CLAWDI_MANAGED_PROVIDER_IDS,
	CLAWDI_MANAGED_V1_PROVIDER_ID,
	CLAWDI_MANAGED_V2_LEGACY_PROVIDER_ID,
	CLAWDI_MANAGED_V2_PROVIDER_ID,
	isAiProviderApiMode,
	isAiProviderType,
} from "@clawdi/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
	type AgentPrimaryModel,
	buildAgentTargetProjection,
	type ProjectionFile,
} from "../lib/ai-provider-projection";
import {
	mergeHermesChannelConfig,
	mergeHermesConfig,
	mergeHermesMcpServer,
	mergeHermesRuntimeLocale,
	removeHermesMcpServer,
	renderHermesChannelConfig,
	renderHermesConfig,
	renderHermesMcpServer,
	renderHermesMcpServerRemoval,
	renderHermesRuntimeLocale,
} from "../lib/hermes-config-merge";
import { writePrivateFileAtomic } from "../lib/private-file";
import { readRuntimeAppliedState } from "./applied-state";
import { ensureRuntimeAuthTokenFile } from "./auth-token";
import { isClawdiManagedProviderProjection, normalizeSecretRef } from "./hosted-egress-profiles";
import {
	buildManagedModelsEndpoint,
	extractManagedLiveModelIds,
	resolveManagedPrimaryModel,
} from "./managed-model-resolution";
import type { LiveSyncAgent, RuntimeInstall, RuntimeManifest } from "./manifest-contract";
import {
	isEnvSecretRef,
	normalizeSecretValues,
	runtimeSecretValue as resolveRuntimeSecretValue,
} from "./secret-values";

export type { RuntimeInstall, RuntimeManifest } from "./manifest-contract";
export {
	loadRuntimeManifest,
	type RuntimeManifestFailure,
	type RuntimeManifestLoad,
	runtimeManifestFixturePath,
} from "./manifest-source";

import {
	RUNTIME_BRIDGE_LISTEN_HOST_ENV,
	RUNTIME_BRIDGE_SURFACES_ENV,
	RUNTIME_BRIDGE_TOKEN_ENV,
	runtimeBridgeSurfaceSpecsForManifest,
} from "./bridge";
import {
	applyEgressTransparentRuntimeEnv,
	MANAGED_EGRESS_PLACEHOLDER_VALUE,
	SYSTEM_CA_BUNDLE,
} from "./egress-env";
import {
	buildEgressProfileBundle,
	hasEnabledEgressProfiles,
	writeEgressProfileBundle,
} from "./egress-profiles";
import type { RuntimeManifestLoad } from "./manifest-source";
import { ensureRuntimeMitmproxy, type RuntimeMitmproxyEnsureResult } from "./mitmproxy-fetch";
import type { RuntimePaths } from "./paths";
import {
	buildRuntimeRunConfig,
	isSupportedRuntimeName,
	type RuntimeName,
	type RuntimeRunConfig,
	type RuntimeServiceName,
	runtimeManagedBinDir,
	runtimeNameSchema,
	runtimeRunConfigId,
	runtimeServiceNameSchema,
	withoutPathEntry,
	writeRuntimeRunConfig,
} from "./run-config";
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

interface RuntimeSystemdApplyHooks {
	activate: () => RuntimeSystemdApplyResult;
	rollback: () => void;
}

type RuntimeLiveSnapshotNode =
	| { kind: "missing" }
	| { kind: "metadata"; existed: false }
	| { kind: "metadata"; existed: true; mode: number; uid: number; gid: number }
	| { kind: "file"; content: Buffer; mode: number; uid: number; gid: number }
	| { kind: "symlink"; target: string; uid: number; gid: number }
	| {
			kind: "directory";
			mode: number;
			uid: number;
			gid: number;
			entries: Map<string, RuntimeLiveSnapshotNode>;
	  };

interface RuntimeLiveSnapshot {
	entries: Map<string, RuntimeLiveSnapshotNode>;
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

function writeJsonFile(path: string, payload: unknown): void {
	writePrivateFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeLastGoodManifest(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	secretValues: Record<string, string> | undefined,
): string | null {
	if (manifest.recovery.cacheManifest === false) {
		rmSync(paths.manifestLastGood, { force: true });
		rmSync(paths.managedSecretCacheFile, { force: true });
		return null;
	}
	writeJsonFile(paths.manifestLastGood, manifest);
	writeLastGoodSecretValues(secretValues, paths, egressSidecarOnlySecretRefs(manifest));
	return paths.manifestLastGood;
}

export function cacheRuntimeLastGoodManifest(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	secretValues?: Record<string, string>,
): string | null {
	return writeLastGoodManifest(manifest, paths, secretValues);
}

function writeLastGoodSecretValues(
	secretValues: Record<string, string> | undefined,
	paths: RuntimePaths,
	excludedRefs: readonly string[] = [],
): void {
	const normalized = omitSecretRefs(secretValues, excludedRefs);
	if (Object.keys(normalized).length === 0) {
		rmSync(paths.managedSecretCacheFile, { force: true });
		return;
	}
	writePrivateFileAtomic(paths.managedSecretCacheFile, `${JSON.stringify(normalized, null, 2)}\n`, {
		mode: 0o600,
		dirMode: 0o755,
	});
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
): void {
	if (!hostedChannelCredentialsDeclared(manifest)) return;
	if (!WHATSAPP_UPSTREAM_READY) {
		removeStaleManagedWhatsAppAuthDirs(manifest, new Set());
		return;
	}
	const credentials = hostedWhatsAppAuthCredentials(manifest);
	const normalizedSecrets = normalizeSecretValues(secretValues);
	const expectedAuthDirs = new Set<string>();
	const errors: string[] = [];
	for (const credential of credentials) {
		const authDirError = managedWhatsAppAuthDirError(manifest, credential);
		if (authDirError) {
			errors.push(authDirError);
			continue;
		}
		expectedAuthDirs.add(resolve(credential.authDir));
		const credsJson = resolveRuntimeSecretValue(normalizedSecrets, credential.credsJsonSecretRef);
		if (!credsJson) {
			removeManagedWhatsAppAuthDir(credential.authDir);
			errors.push(
				`missing WhatsApp auth state secret for ${credential.accountKey}/${credential.credentialId}`,
			);
			continue;
		}
		try {
			materializeManagedWhatsAppAuthDir(credential, credsJson);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	removeStaleManagedWhatsAppAuthDirs(manifest, expectedAuthDirs);
	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
}

function validateHostedChannelCredentialsPlan(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
): void {
	if (!hostedChannelCredentialsDeclared(manifest) || !WHATSAPP_UPSTREAM_READY) return;
	const normalizedSecrets = normalizeSecretValues(secretValues);
	for (const credential of hostedWhatsAppAuthCredentials(manifest)) {
		const authDirError = managedWhatsAppAuthDirError(manifest, credential);
		if (authDirError) throw new Error(authDirError);
		const credsJson = resolveRuntimeSecretValue(normalizedSecrets, credential.credsJsonSecretRef);
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

	makeRuntimeUserPrivateDir(credential.authDir);
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
	manifest: RuntimeManifest,
	credential: ManagedWhatsAppAuthCredential,
): string | null {
	const roots = managedWhatsAppAuthRootsForCredential(manifest, credential);
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
	manifest: RuntimeManifest,
	credential: ManagedWhatsAppAuthCredential,
): string[] {
	const roots = managedWhatsAppAuthRoots(manifest);
	if (credential.target === "hermes") {
		return roots.hermes ? [roots.hermes] : [];
	}
	if (credential.target === "openclaw" || credential.target === "legacy") {
		return roots.openclaw ? [roots.openclaw] : [];
	}
	return [roots.openclaw, roots.hermes].filter((root): root is string => Boolean(root));
}

function managedWhatsAppAuthRoots(manifest: RuntimeManifest): {
	openclaw: string | null;
	hermes: string | null;
} {
	const home = projectionSystemHome(manifest) ?? process.env.HOME ?? "";
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

function removeStaleManagedWhatsAppAuthDirs(
	manifest: RuntimeManifest,
	expected: Set<string>,
): void {
	for (const root of Object.values(managedWhatsAppAuthRoots(manifest))) {
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
): string | null {
	const scoped = scopedSecretValues(secretValues, refs);
	if (Object.keys(scoped).length === 0) {
		rmSync(path, { force: true });
		return null;
	}
	writePrivateFileAtomic(path, `${JSON.stringify(scoped, null, 2)}\n`, {
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

function scopedSecretValues(
	secretValues: Record<string, string> | undefined,
	refs: readonly string[],
): Record<string, string> {
	const normalizedValues = normalizeSecretValues(secretValues);
	const scoped: Record<string, string> = {};
	for (const ref of refs) {
		if (isEnvSecretRef(ref)) continue;
		const value = resolveRuntimeSecretValue(normalizedValues, ref);
		if (!value) continue;
		scoped[ref] = value;
		const normalized = normalizeSecretRef(ref);
		if (normalized) scoped[normalized] = value;
		if (ref.startsWith("secret://")) scoped[ref.slice("secret://".length)] = value;
	}
	return scoped;
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

function providerSecretAvailable(secretValues: Record<string, string>, ref: string): boolean {
	const normalized = normalizeSecretRef(ref);
	return Boolean(secretValues[ref] || (normalized ? secretValues[normalized] : undefined));
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

function makeRuntimeUserPrivateDir(path: string): void {
	mkdirSync(path, { recursive: true });
	makeRuntimeUserOwnedAncestors(path);
	makeRuntimeUserOwned(path);
	try {
		chmodSync(path, 0o700);
	} catch {
		// Best effort for non-POSIX local development environments.
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

function makeRuntimeUserOwnedAncestors(path: string): void {
	const home = process.env.HOME ? resolve(process.env.HOME) : null;
	if (!home) return;
	let current = resolve(dirname(path));
	while (current === home || current.startsWith(`${home}/`)) {
		makeRuntimeUserOwned(current);
		if (current === home) return;
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
	return typeof process.getuid === "function" && process.getuid() === 0;
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

	mkdirSync(install.home, { recursive: true });
	makeRuntimeUserOwned(install.home);
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

function observeRuntimeInstall(name: string, runtime: RuntimeManifest["runtimes"][string]) {
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
				appRoot: commandPath ? runtimeAppRoot(name, process.env.HOME ?? "") : null,
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
): RuntimeInstallObservation {
	if (!runtime.install) return observeRuntimeInstall(name, runtime);
	if (!runtime.enabled) return observeRuntimeInstall(name, runtime);
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
					: "clawdi mcp",
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
	if (!locale) return null;
	const block = managedLocaleBlock(locale);
	if (runtime === "openclaw") {
		return updateManagedLocaleFile(join(workspaceRoot, "SOUL.md"), block);
	}
	if (runtime === "hermes") {
		const hermesHome = join(home, ".hermes");
		makeRuntimeUserPrivateDir(hermesHome);
		const configPath = join(hermesHome, "config.yaml");
		mergeHermesRuntimeLocale(configPath, locale.timezone);
		makeRuntimeUserOwned(configPath);
		return updateManagedLocaleFile(join(hermesHome, "SOUL.md"), block);
	}
	return null;
}

export function hostedAiProviderCatalog(
	manifest: RuntimeManifest,
	runtimeName?: string,
	options: { primaryModelOverride?: AgentPrimaryModel } = {},
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
): NonNullable<AiProviderCatalog["providers"][number]["models"]> {
	const providerApiMode = hostedProviderApiMode(input);
	// Hosted wire rejects singular model; this fallback serves generic provider projections only.
	const singularModel = stringValue(input.model);
	if (hostedProviderManagedBy(input) === "clawdi") {
		if (primaryModel) {
			return [{ id: primaryModel.model, api_mode: providerApiMode }];
		}
		return singularModel ? [{ id: singularModel, api_mode: providerApiMode }] : [];
	}

	const rawModels = Array.isArray(input.models) ? input.models : [];
	const models = rawModels
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

function resolveManagedGatewayPrimaryModelOverrides(
	manifest: RuntimeManifest,
	enabledRuntimes: readonly string[],
	home: string,
	workspaceRoot: string,
	egressSystemCaFile: string | null,
	fetcher: ManagedGatewayModelListFetcher,
): Partial<Record<string, AgentPrimaryModel>> {
	const overrides: Partial<Record<string, AgentPrimaryModel>> = {};
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
				console.warn(
					`managed model probe failed for ${runtimeName}/${target.providerId} at ${fetchResult.endpoint}: ${fetchResult.detail}; keeping configured seed`,
				);
			}
		}
		const resolution = resolveManagedPrimaryModel({
			seedModel: target.seedModel,
			liveModelIds: fetchResult.status === "ok" ? fetchResult.modelIds : null,
		});
		if (!resolution.resolvedModel) continue;
		if (resolution.resolvedModel === target.seedModel) continue;
		overrides[runtimeName] = {
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
		return { status: "ok", endpoint, modelIds: extractManagedLiveModelIds(body) };
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

function writeEgressSecretFile(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	paths: RuntimePaths,
): string | null {
	return writeScopedSecretValues(
		egressSecretFilePath(paths),
		secretValues,
		egressSecretRefs(manifest),
		paths,
		"egress-identity",
	);
}

function egressSecretRefs(manifest: RuntimeManifest): string[] {
	const refs = new Set<string>();
	collectSecretRefs(manifest.egressProfiles, refs);
	return [...refs].sort();
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

type HostedAiProviderProjectionInput = {
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
		// TODO(#425): Remove legacy projection handling after hosted#892 is deployed
		// everywhere and no dev/self-hosted binding still uses clawdi-managed-v2.
		const id =
			CLAWDI_MANAGED_PROVIDER_IDS.has(provider.id) || provider.id.startsWith("clawdi-managed")
				? provider.id
				: CLAWDI_MANAGED_V1_PROVIDER_ID;
		providerIdMap.set(provider.id, id);
		return {
			...provider,
			id,
			api_mode:
				id === CLAWDI_MANAGED_V2_PROVIDER_ID || id === CLAWDI_MANAGED_V2_LEGACY_PROVIDER_ID
					? "openai_chat"
					: "openai_responses",
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
			modelIds: string[];
	  }
	| {
			status: "failed";
			detail: string;
			endpoint: string;
	  };

type ManagedGatewayModelListFetcher = (
	input: ManagedGatewayModelFetchInput,
) => ManagedGatewayModelFetchResult;

interface HermesHostedProviderPluginProjection {
	modelPatch: string;
	pluginFiles: ProjectionFile[];
	revision: string;
}

interface HermesHostedPluginProviderProfile {
	description: string;
	displayName: string;
	envName: string;
	fallbackModels: string[];
	pluginProviderName: string;
	primaryModelDetails: {
		context_length?: number;
		max_tokens?: number;
		supports_vision?: boolean;
	} | null;
	provider: AiProviderCatalog["providers"][number];
	providerApiMode: string;
}

const HERMES_MODEL_PROVIDER_PLUGIN_NAME = "clawdi";
const HERMES_MODEL_PROVIDER_PLUGIN_VERSION = "1.0.0";
const HERMES_MODEL_PROVIDER_PLUGIN_MIN_VERSION = [0, 18, 0] as const;
const HERMES_PROVIDER_PROFILE_API_MODES: Partial<Record<AiProviderApiMode, string>> = {
	openai_chat: "chat_completions",
	openai_responses: "codex_responses",
	anthropic_messages: "anthropic_messages",
};

function applyHostedAiProviderProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	workspaceRoot: string,
	previousProviderIds: readonly string[],
	managedPrimaryModelOverrides: Partial<Record<string, AgentPrimaryModel>>,
): HostedAiProviderProjectionResult {
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return { path: null, revision: null, providerIds: [] };
	}
	const projectionInput = agentTargetProjectionInput(
		hostedAiProviderCatalog(manifest, name, {
			primaryModelOverride: managedPrimaryModelOverrides[name],
		}),
	);
	assertHostedProviderProjectionMode(name, manifest, projectionInput);
	const home = projectionSystemHome(manifest) ?? process.env.HOME ?? "";
	if (manifest.runtimes[name]?.providerMode === "configured" && !projectionInput) {
		if (name === "openclaw") {
			applyOpenClawGatewayHostedProjection(observation.commandPath, manifest, home, workspaceRoot);
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
		const activeProviderIds = projectionInput
			? [...openClawProjectedProviderIds(projectionInput)].sort()
			: [];
		const deletedProviderIds = staleProviderIds(
			new Set(previousProviderIds),
			new Set(activeProviderIds),
		);
		if (projectionInput) {
			applyOpenClawHostedProviderProjection(
				observation.commandPath,
				projectionInput,
				deletedProviderIds,
				home,
				workspaceRoot,
			);
		} else if (deletedProviderIds.length > 0) {
			applyOpenClawHostedProviderDeleteProjection(
				observation.commandPath,
				deletedProviderIds,
				home,
				workspaceRoot,
			);
		}
		applyOpenClawGatewayHostedProjection(observation.commandPath, manifest, home, workspaceRoot);
		return { path: observation.commandPath, revision: null, providerIds: activeProviderIds };
	}
	return { path: null, revision: null, providerIds: [] };
}

function previewHostedAiProviderProjectionRevision(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	workspaceRoot: string,
	previousProviderIds: readonly string[],
	managedPrimaryModelOverrides: Partial<Record<string, AgentPrimaryModel>>,
): string | null {
	if (
		name !== "hermes" ||
		!observation.enabled ||
		observation.status === "install_failed" ||
		!observation.commandPath
	) {
		return null;
	}
	const projectionInput = agentTargetProjectionInput(
		hostedAiProviderCatalog(manifest, name, {
			primaryModelOverride: managedPrimaryModelOverrides[name],
		}),
	);
	assertHostedProviderProjectionMode(name, manifest, projectionInput);
	if (manifest.runtimes[name]?.providerMode === "configured" && !projectionInput) {
		return null;
	}
	return applyHostedHermesAiProviderProjection(
		observation,
		projectionInput,
		previousProviderIds,
		projectionSystemHome(manifest) ?? process.env.HOME ?? "",
		workspaceRoot,
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
	makeRuntimeUserPrivateDir(codexHome);
	const configPath = join(codexHome, CODEX_MANAGED_PROVIDER_CONFIG_FILE);
	const configContent = hostedCodexManagedConfigToml(provider);
	writePrivateFileAtomic(configPath, configContent, { mode: 0o600, dirMode: 0o700 });
	makeRuntimeUserOwned(configPath);
	makeRuntimeUserPrivateDir(codexHome);

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
	workspaceRoot: string,
	apply = true,
): HostedAiProviderProjectionResult {
	const configPath = join(home, ".hermes", "config.yaml");
	if (!projectionInput) {
		if (apply && previousProviderIds.length > 0) removeHermesModelProviderPlugin(home);
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
	const version = detectHermesInstalledVersion(commandPath, home, workspaceRoot);
	if (!supportsHermesModelProviderPlugins(version)) {
		if (apply) removeHermesModelProviderPlugin(home);
		const projection = buildAgentTargetProjection(
			"hermes",
			projectionInput.catalog,
			projectionInput.primaryModel,
		);
		const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
		if (!file) throw new Error("Hermes projection did not include a config merge YAML file.");
		const activeProviderIds = [...hermesProjectedProviderIds(projectionInput, "yaml-merge")].sort();
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

	const pluginProjection = buildHermesHostedProviderPluginProjection(
		projectionInput.catalog,
		projectionInput.primaryModel,
	);
	const activeProviderIds = [...hermesProjectedProviderIds(projectionInput, "plugin")].sort();
	const deletedProviderIds = staleProviderIds(
		new Set(previousProviderIds),
		new Set(activeProviderIds),
	);
	const existingDeletedProviderIds = existingHermesProviderIds(configPath, deletedProviderIds);
	const modelPatch = mergeHermesProviderDeletes(
		pluginProjection.modelPatch,
		existingDeletedProviderIds,
	);
	const pluginDir = apply
		? syncHermesModelProviderPlugin(home, pluginProjection.pluginFiles)
		: hermesModelProviderPluginDir(home);
	if (apply) {
		mergeHermesConfig(configPath, modelPatch);
		makeRuntimeUserOwned(configPath);
	}
	return {
		path: pluginDir,
		providerIds: activeProviderIds,
		revision: revisionHash({
			hermesProviderProjection: "plugin",
			modelPatch,
			pluginFiles: pluginProjection.pluginFiles,
		}),
	};
}

function detectHermesInstalledVersion(command: string, home: string, cwd: string): string | null {
	const result = spawnRuntimeUserCommand(command, ["--version"], home, cwd);
	if (result.status !== 0) return null;
	const output = [result.stdout, result.stderr]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	const match = output.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
	return match?.[1] ?? null;
}

function supportsHermesModelProviderPlugins(version: string | null): boolean {
	const parsed = parseSemverishVersion(version);
	if (!parsed) return false;
	return compareSemverParts(parsed, HERMES_MODEL_PROVIDER_PLUGIN_MIN_VERSION) >= 0;
}

function parseSemverishVersion(version: string | null): [number, number, number] | null {
	if (!version) return null;
	const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	const patch = Number.parseInt(match[3] ?? "", 10);
	if (![major, minor, patch].every((part) => Number.isInteger(part) && part >= 0)) {
		return null;
	}
	return [major, minor, patch];
}

function compareSemverParts(
	left: readonly [number, number, number],
	right: readonly [number, number, number],
): number {
	const [leftMajor, leftMinor, leftPatch] = left;
	const [rightMajor, rightMinor, rightPatch] = right;
	return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}

function buildHermesHostedProviderPluginProjection(
	catalog: AiProviderCatalog,
	primaryModel: AgentPrimaryModel,
): HermesHostedProviderPluginProjection {
	const profiles = catalog.providers.map((provider) =>
		buildHermesHostedPluginProviderProfile(
			provider,
			provider.id === primaryModel.provider_id ? primaryModel.model : null,
		),
	);
	const primaryProvider = profiles.find((entry) => entry.provider.id === primaryModel.provider_id);
	if (!primaryProvider?.primaryModelDetails) {
		throw new Error(
			`Hermes hosted provider projection cannot find primary provider ${primaryModel.provider_id}.`,
		);
	}
	const pluginFiles: ProjectionFile[] = [
		{
			path: "__init__.py",
			content: buildHermesHostedPluginInit(profiles),
		},
		{
			path: "plugin.yaml",
			content: [
				`name: ${quoteYaml(HERMES_MODEL_PROVIDER_PLUGIN_NAME)}`,
				"kind: model-provider",
				`version: ${quoteYaml(HERMES_MODEL_PROVIDER_PLUGIN_VERSION)}`,
				'description: "Clawdi hosted AI provider projection"',
				'author: "Clawdi"',
				"",
			].join("\n"),
		},
	];
	const compatibilityProviders = buildHermesHostedCompatibilityProviders(profiles);
	const modelPatch = buildHermesHostedPluginModelPatch(
		primaryModel,
		primaryProvider.pluginProviderName,
		primaryProvider.primaryModelDetails,
		compatibilityProviders,
	);
	return {
		modelPatch,
		pluginFiles,
		revision: revisionHash({
			hermesProviderProjection: "plugin",
			modelPatch,
			pluginFiles,
		}),
	};
}

function buildHermesHostedPluginProviderProfile(
	provider: AiProviderCatalog["providers"][number],
	primaryModelId: string | null,
): HermesHostedPluginProviderProfile {
	const envName = provider.runtime_env_name?.trim();
	if (!envName || !isEnvKey(envName)) {
		throw new Error(
			`Hermes model-provider plugin projection requires a valid runtime_env_name for ${provider.id}.`,
		);
	}
	if (provider.auth.type !== "api_key") {
		throw new Error(
			`Hermes model-provider plugin projection requires api_key auth for ${provider.id}; got ${provider.auth.type}.`,
		);
	}
	const providerApiMode = provider.api_mode;
	if (!providerApiMode) {
		throw new Error(
			`Hermes model-provider plugin projection requires api_mode for ${provider.id}.`,
		);
	}
	const apiMode = HERMES_PROVIDER_PROFILE_API_MODES[providerApiMode];
	if (!apiMode) {
		throw new Error(
			`Hermes model-provider plugin projection does not support api_mode ${providerApiMode} for ${provider.id}.`,
		);
	}

	const displayName = provider.label?.trim() || provider.id;
	return {
		description: `${displayName} projected by Clawdi runtime converge`,
		displayName,
		envName,
		fallbackModels: hermesHostedFallbackModels(provider, primaryModelId),
		pluginProviderName: hermesHostedPluginProviderName(provider.id),
		primaryModelDetails:
			primaryModelId === null ? null : hermesHostedPrimaryModelDetails(provider, primaryModelId),
		provider,
		providerApiMode: apiMode,
	};
}

function buildHermesHostedPluginInit(
	profiles: readonly HermesHostedPluginProviderProfile[],
): string {
	const lines = [
		'"""Clawdi hosted AI provider projection."""',
		"",
		"from providers import register_provider",
		"from providers.base import ProviderProfile",
		"",
	];
	for (const profile of profiles) {
		const profileArgs = [
			`name=${pythonStringLiteral(profile.pluginProviderName)}`,
			`display_name=${pythonStringLiteral(profile.displayName)}`,
			`description=${pythonStringLiteral(profile.description)}`,
			`env_vars=${pythonTupleLiteral([profile.envName])}`,
			`base_url=${pythonStringLiteral(profile.provider.base_url)}`,
			'auth_type="api_key"',
			`api_mode=${pythonStringLiteral(profile.providerApiMode)}`,
			...(profile.fallbackModels.length > 0
				? [`fallback_models=${pythonTupleLiteral(profile.fallbackModels)}`]
				: []),
		];
		lines.push(
			"register_provider(",
			"    ProviderProfile(",
			...profileArgs.map((line) => `        ${line},`),
			"    )",
			")",
			"",
		);
	}
	return `${lines.join("\n")}\n`;
}

function buildHermesHostedCompatibilityProviders(
	profiles: readonly HermesHostedPluginProviderProfile[],
): Record<string, unknown> {
	const providers: Record<string, unknown> = {};
	for (const profile of profiles) {
		const models = buildHermesHostedCompatibilityProviderModels(profile.provider);
		providers[profile.pluginProviderName] =
			Object.keys(models).length > 0
				? {
						api: profile.provider.base_url,
						models,
					}
				: {
						api: profile.provider.base_url,
					};
	}
	return providers;
}

function buildHermesHostedCompatibilityProviderModels(
	provider: AiProviderCatalog["providers"][number],
): Record<string, unknown> {
	const models: Record<string, unknown> = {};
	for (const model of provider.models ?? []) {
		const modelId = model.id.trim();
		if (!modelId || Object.hasOwn(models, modelId)) continue;
		const metadata: Record<string, unknown> = {};
		const contextLength = positiveInteger(model.context_window);
		if (contextLength !== undefined) metadata.context_length = contextLength;
		const supportsVision = hermesHostedSupportsVision(model);
		if (supportsVision !== undefined) metadata.supports_vision = supportsVision;
		const cost = hermesHostedModelCost(model.cost);
		if (cost) Object.assign(metadata, cost);
		if (Object.keys(metadata).length === 0) continue;
		models[modelId] = metadata;
	}
	return models;
}

function hermesHostedModelCost(
	cost: AiProviderModel["cost"] | undefined,
): Record<string, number> | undefined {
	if (!cost) return undefined;
	const input = nonNegativeNumber(cost.input);
	const output = nonNegativeNumber(cost.output);
	if (input === undefined || output === undefined) return undefined;
	return {
		input_cost_per_million: input,
		output_cost_per_million: output,
		...(nonNegativeNumber(cost.cache_read) !== undefined
			? { cache_read_cost_per_million: nonNegativeNumber(cost.cache_read) }
			: {}),
		...(nonNegativeNumber(cost.cache_write) !== undefined
			? { cache_write_cost_per_million: nonNegativeNumber(cost.cache_write) }
			: {}),
	};
}

function buildHermesHostedPluginModelPatch(
	primaryModel: AgentPrimaryModel,
	primaryPluginProviderName: string,
	primaryModelDetails: {
		context_length?: number;
		max_tokens?: number;
		supports_vision?: boolean;
	},
	compatibilityProviders: Record<string, unknown>,
): string {
	const patch: Record<string, unknown> = {
		model: {
			provider: primaryPluginProviderName,
			default: primaryModel.model,
			context_length: primaryModelDetails.context_length ?? null,
			max_tokens: primaryModelDetails.max_tokens ?? null,
			supports_vision: primaryModelDetails.supports_vision ?? null,
		},
	};
	if (Object.keys(compatibilityProviders).length > 0) {
		patch.providers = compatibilityProviders;
	}
	return [
		"# Generated by Clawdi. Merge this patch into Hermes config.yaml.",
		"# Contract: Hermes Agent 0.18.x discovers model-provider plugins from",
		`# $HERMES_HOME/plugins/model-providers/${HERMES_MODEL_PROVIDER_PLUGIN_NAME}/.`,
		stringifyYaml(patch).trimEnd(),
		"",
	].join("\n");
}

function hermesHostedPrimaryModelDetails(
	provider: AiProviderCatalog["providers"][number],
	modelId: string,
): { context_length?: number; max_tokens?: number; supports_vision?: boolean } {
	const model = provider.models?.find((entry) => entry.id === modelId);
	return {
		context_length: positiveInteger(model?.context_window),
		max_tokens: positiveInteger(model?.max_tokens),
		supports_vision: hermesHostedSupportsVision(model),
	};
}

function hermesHostedFallbackModels(
	provider: AiProviderCatalog["providers"][number],
	primaryModelId: string | null,
): string[] {
	const ordered = [
		...(primaryModelId ? [primaryModelId] : []),
		...(provider.models ?? []).map((entry) => entry.id).filter((value) => value.trim().length > 0),
	];
	return ordered.filter((value, index, entries) => entries.indexOf(value) === index);
}

function hermesHostedSupportsVision(
	model: NonNullable<AiProviderCatalog["providers"][number]["models"]>[number] | undefined,
): boolean | undefined {
	if (!model) return undefined;
	if (typeof model.supports_vision === "boolean") return model.supports_vision;
	return model.input_modalities?.includes("image") ? true : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function pythonStringLiteral(value: string): string {
	return JSON.stringify(value);
}

function pythonTupleLiteral(values: readonly string[]): string {
	if (values.length === 0) return "()";
	return `(${values.map((value) => pythonStringLiteral(value)).join(", ")}${
		values.length === 1 ? "," : ""
	})`;
}

function quoteYaml(value: string): string {
	return JSON.stringify(value);
}

function quoteTomlString(value: string): string {
	return JSON.stringify(value);
}

function hermesHostedPluginProviderName(providerId: string): string {
	const normalized = providerId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${HERMES_MODEL_PROVIDER_PLUGIN_NAME}-${normalized || "provider"}`;
}

function hermesModelProviderPluginDir(home: string): string {
	return join(home, ".hermes", "plugins", "model-providers", HERMES_MODEL_PROVIDER_PLUGIN_NAME);
}

function syncHermesModelProviderPlugin(home: string, files: ProjectionFile[]): string {
	const pluginsDir = join(home, ".hermes", "plugins");
	const providersDir = join(pluginsDir, "model-providers");
	const pluginDir = hermesModelProviderPluginDir(home);
	rmSync(pluginDir, { recursive: true, force: true });
	makeRuntimeUserPrivateDir(pluginsDir);
	makeRuntimeUserPrivateDir(providersDir);
	makeRuntimeUserPrivateDir(pluginDir);
	for (const file of files) {
		const path = join(pluginDir, file.path);
		writePrivateFileAtomic(path, file.content);
		makeRuntimeUserOwned(path);
	}
	return pluginDir;
}

function removeHermesModelProviderPlugin(home: string): void {
	rmSync(hermesModelProviderPluginDir(home), { recursive: true, force: true });
}

function applyOpenClawHostedProviderProjection(
	command: string,
	projectionInput: HostedAiProviderProjectionInput,
	deletedProviderIds: readonly string[],
	home: string,
	workspaceRoot: string,
): void {
	const projection = buildAgentTargetProjection(
		"openclaw",
		projectionInput.catalog,
		projectionInput.primaryModel,
	);
	const file = projection.files.find((entry) => entry.path.endsWith(".openclaw.json"));
	if (!file) throw new Error("OpenClaw projection did not include a config patch JSON file.");
	runRuntimeUserCommand(
		command,
		["config", "patch", "--stdin"],
		mergeOpenClawProviderDeletes(file.content, deletedProviderIds),
		home,
		workspaceRoot,
	);
}

function applyOpenClawHostedProviderDeleteProjection(
	command: string,
	deletedProviderIds: readonly string[],
	home: string,
	workspaceRoot: string,
): void {
	runRuntimeUserCommand(
		command,
		["config", "patch", "--stdin"],
		`${JSON.stringify(openClawProviderDeletePatch(deletedProviderIds), null, 2)}\n`,
		home,
		workspaceRoot,
	);
}

function openClawProjectedProviderIds(
	projectionInput: HostedAiProviderProjectionInput,
): Set<string> {
	const projection = buildAgentTargetProjection(
		"openclaw",
		projectionInput.catalog,
		projectionInput.primaryModel,
	);
	const file = projection.files.find((entry) => entry.path.endsWith(".openclaw.json"));
	if (!file) return new Set();
	return openClawProviderIdsFromPatch(file.content);
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

function hermesProjectedProviderIds(
	projectionInput: HostedAiProviderProjectionInput,
	mode: "plugin" | "yaml-merge",
): Set<string> {
	const patchContent =
		mode === "plugin"
			? buildHermesHostedProviderPluginProjection(
					projectionInput.catalog,
					projectionInput.primaryModel,
				).modelPatch
			: (buildAgentTargetProjection(
					"hermes",
					projectionInput.catalog,
					projectionInput.primaryModel,
				).files.find((entry) => entry.path.endsWith(".hermes.yaml"))?.content ?? "");
	return hermesProviderIdsFromPatch(patchContent);
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

function openClawGatewayHostedPatch(manifest: RuntimeManifest): Record<string, unknown> | null {
	const allowedOrigins = openClawControlUiAllowedOrigins(manifest);
	const gatewayToken = process.env[OPENCLAW_GATEWAY_TOKEN_ENV]?.trim();
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
		...(gatewayToken || allowedOrigins.length > 0
			? {
					gateway: {
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
										// Clawdi's runtime bridge owns browser auth for hosted Control UI
										// traffic, so OpenClaw's local device-auth prompt would be a second
										// owner gate behind the already-authenticated edge.
										dangerouslyDisableDeviceAuth: true,
									},
								}
							: {}),
					},
				}
			: {}),
	};
}

function applyOpenClawGatewayHostedProjection(
	command: string,
	manifest: RuntimeManifest,
	home: string,
	workspaceRoot: string,
): void {
	const patch = openClawGatewayHostedPatch(manifest);
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
	workspaceRoot: string,
): string | null {
	if (name !== "openclaw" && name !== "hermes") return null;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return null;
	}
	const channels = hostedChannelProjection(manifest);
	if (!channels) return null;

	const home = projectionSystemHome(manifest) ?? process.env.HOME ?? "";
	if (name === "hermes") {
		const configPath = join(home, ".hermes", "config.yaml");
		mergeHermesChannelConfig(
			configPath,
			hermesManagedChannelsPatch(
				channels,
				manifest.controlPlane.apiUrl,
				manifest.projection?.channelCredentials,
			),
		);
		makeRuntimeUserOwned(configPath);
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
	workspaceRoot: string,
): void {
	if (name !== "openclaw") return;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return;
	}
	const channels = hostedChannelProjection(manifest);
	if (!channels) return;
	const home = projectionSystemHome(manifest) ?? process.env.HOME ?? "";
	installOpenClawChannelPlugins(observation.commandPath, channels, home, workspaceRoot);
}

function hermesManagedChannelsPatch(
	channels: Record<string, unknown>,
	cloudApiUrl: string,
	channelCredentials: unknown,
): Record<string, Record<string, unknown>> {
	const baseUrl = stripTrailingSlash(cloudApiUrl);
	const whatsapp = hermesWhatsAppProjection(channels, channelCredentials, baseUrl);
	return {
		telegram: channelHasAccounts(channels.telegram)
			? {
					enabled: true,
					dm_policy: "open",
					group_policy: "open",
					allow_from: ["*"],
					group_allow_from: ["*"],
					group_allowed_chats: ["*"],
					require_mention: false,
					extra: {
						base_url: `${baseUrl}/v1/channels/telegram/bot`,
						base_file_url: `${baseUrl}/v1/channels/telegram/file/bot`,
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

function installOpenClawChannelPlugins(
	commandPath: string,
	channels: Record<string, unknown>,
	home: string,
	workspaceRoot: string,
): void {
	for (const channel of Object.keys(channels).sort()) {
		if (channel === "whatsapp" && !WHATSAPP_UPSTREAM_READY) continue;
		const specs = OPENCLAW_EXTERNAL_CHANNEL_PLUGIN_SPECS[channel];
		if (!specs) continue;
		runPluginInstallWithFallback(commandPath, specs, home, workspaceRoot);
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

function hostedMcpProjectionEnabled(manifest: RuntimeManifest): boolean {
	const projection = manifest.projection;
	if (!projection) return false;
	if (isPlainRecord(projection.mcp) && projection.mcp.enabled === false) return false;
	return projection.mcp !== undefined || projection.tools !== undefined;
}

function hostedMcpProjectionDeclared(manifest: RuntimeManifest): boolean {
	const projection = manifest.projection;
	return Boolean(projection && (projection.mcp !== undefined || projection.tools !== undefined));
}

function hostedMcpServerConfig(
	manifest: RuntimeManifest,
	authTokenFile: string,
): { command: string; args: string[] } {
	return {
		command: "clawdi",
		args: ["mcp", "--api-url", manifest.controlPlane.apiUrl, "--auth-token-file", authTokenFile],
	};
}

function applyHostedMcpProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	workspaceRoot: string,
	daemonAuthTokenFile: string | null,
): string | null {
	const home = projectionSystemHome(manifest) ?? process.env.HOME ?? "";
	if (!hostedMcpProjectionDeclared(manifest)) return null;
	if (!hostedMcpProjectionEnabled(manifest)) {
		return removeHostedMcpProjection(name, observation, manifest, home, workspaceRoot);
	}
	if (!daemonAuthTokenFile) return null;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return null;
	}
	const server = hostedMcpServerConfig(manifest, daemonAuthTokenFile);
	if (name === "openclaw") {
		runRuntimeUserCommand(
			observation.commandPath,
			["mcp", "set", "clawdi", JSON.stringify(server)],
			"",
			home,
			workspaceRoot,
		);
		return observation.commandPath;
	}
	if (name === "hermes") {
		const configPath = join(home, ".hermes", "config.yaml");
		mergeHermesMcpServer(configPath, "clawdi", server);
		makeRuntimeUserOwned(configPath);
		return configPath;
	}
	return null;
}

function removeHostedMcpProjection(
	name: string,
	observation: RuntimeInstallObservation,
	_manifest: RuntimeManifest,
	home: string,
	workspaceRoot: string,
): string | null {
	if (name === "openclaw") {
		const commandPath = observation.commandPath ?? runtimeCommandPath(name, home);
		if (!commandPath || !executableExists(commandPath)) return null;
		runRuntimeUserCommand(commandPath, ["mcp", "unset", "clawdi"], "", home, workspaceRoot);
		return commandPath;
	}
	if (name === "hermes") {
		const configPath = join(home, ".hermes", "config.yaml");
		removeHermesMcpServer(configPath, "clawdi");
		makeRuntimeUserOwned(configPath);
		return configPath;
	}
	return null;
}

function projectionSystemHome(manifest: RuntimeManifest): string | null {
	const system = manifest.projection?.system;
	if (typeof system !== "object" || system === null || Array.isArray(system)) return null;
	const home = (system as Record<string, unknown>).home;
	return typeof home === "string" && home.trim() ? home.trim() : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeUserCommandEnv(
	home: string,
	options: { egressSystemCaFile?: string } = {},
): NodeJS.ProcessEnv {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	const uid =
		runtimeUser && runtimeUser !== "root" && runningAsRoot()
			? String(runtimeUserUid(runtimeUser))
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
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(here, "../../egress-addon/clawdi_egress_addon.py"),
		resolve(here, "../egress-addon/clawdi_egress_addon.py"),
		resolve(here, "egress-addon/clawdi_egress_addon.py"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("packaged egress addon is missing");
}

function writeTransparentEgressEnvFile(input: {
	program: RuntimeEgressSystemdProgram | null;
	paths: RuntimePaths;
	runtimeUser: string;
	runtimeUid: number;
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
	const envDir = paths.localEnvironments;
	mkdirSync(envDir, { recursive: true });
	makeRuntimeUserOwned(envDir);
	const agents = desiredLiveSyncAgents(manifest);
	const desiredTypes = new Set(agents.map((agent) => agent.agentType));
	const staleCandidates = new Set<RuntimeName>([
		...readLiveSyncEnvironmentIndex(paths),
		...MANAGED_LIVE_SYNC_AGENTS,
	] as RuntimeName[]);
	for (const agentType of staleCandidates) {
		if (!desiredTypes.has(agentType)) {
			rmSync(join(envDir, `${agentType}.json`), { force: true });
		}
	}
	const written: string[] = [];
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
		written.push(path);
	}
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

function writeDaemonAuthToken(paths: RuntimePaths): string | null {
	const path = ensureRuntimeAuthTokenFile(paths);
	if (!path) return null;
	makeManagedSecretRoot(dirname(path));
	makeRootOwned(path);
	return path;
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

function sleepSync(ms: number): void {
	const signal = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(signal, 0, 0, ms);
}

function convergeLockOwnerPath(lockDir: string): string {
	return join(lockDir, "owner.json");
}

function writeConvergeFileAtomic(path: string, content: string, mode: number): void {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	let renamed = false;
	try {
		writeFileSync(tmp, content, { mode });
		renameSync(tmp, path);
		renamed = true;
	} finally {
		if (!renamed) rmSync(tmp, { force: true });
	}
}

function writeConvergeLockOwner(lockDir: string): void {
	writeConvergeFileAtomic(
		convergeLockOwnerPath(lockDir),
		`${JSON.stringify({
			schemaVersion: "clawdi.runtimeConvergeLockOwner.v1",
			pid: process.pid,
			acquiredAt: new Date().toISOString(),
		})}\n`,
		0o600,
	);
}

function readConvergeLockOwnerPid(lockDir: string): number | null {
	try {
		const raw = JSON.parse(readFileSync(convergeLockOwnerPath(lockDir), "utf-8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const pid = (raw as Record<string, unknown>).pid;
		return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ESRCH"
		) {
			return false;
		}
		return true;
	}
}

function reclaimStaleConvergeLock(lockDir: string, timeoutMs: number): boolean {
	const ownerPid = readConvergeLockOwnerPid(lockDir);
	if (ownerPid === null) {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(lockDir).mtimeMs;
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return true;
			}
			throw error;
		}
		if (Date.now() - mtimeMs <= 2 * timeoutMs) return false;
	} else if (processIsAlive(ownerPid)) {
		return false;
	}
	const staleDir = `${lockDir}.stale.${process.pid}.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2)}`;
	try {
		renameSync(lockDir, staleDir);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return true;
		}
		throw error;
	}
	rmSync(staleDir, { recursive: true, force: true });
	return true;
}

export function withRuntimeConvergeLock<T>(
	paths: RuntimePaths,
	fn: () => T,
	opts: { timeoutMs?: number } = {},
): T {
	const timeoutMs = opts.timeoutMs ?? 300_000;
	const lockRoot = join(paths.runRoot, "locks");
	const lockDir = join(lockRoot, "converge.lock");
	const startedAt = Date.now();
	mkdirSync(lockRoot, { recursive: true });
	for (;;) {
		try {
			mkdirSync(lockDir);
			try {
				writeConvergeLockOwner(lockDir);
			} catch (error) {
				rmSync(lockDir, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				(error as NodeJS.ErrnoException).code !== "EEXIST"
			) {
				throw error;
			}
			if (reclaimStaleConvergeLock(lockDir, timeoutMs)) {
				continue;
			}
			if (Date.now() - startedAt > timeoutMs) {
				throw new Error(`timed out waiting for runtime converge lock at ${lockDir}`);
			}
			sleepSync(100);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

export async function withRuntimeConvergeLockAsync<T>(
	paths: RuntimePaths,
	fn: () => Promise<T>,
	opts: { timeoutMs?: number } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 300_000;
	const lockRoot = join(paths.runRoot, "locks");
	const lockDir = join(lockRoot, "converge.lock");
	const startedAt = Date.now();
	mkdirSync(lockRoot, { recursive: true });
	for (;;) {
		try {
			mkdirSync(lockDir);
			try {
				writeConvergeLockOwner(lockDir);
			} catch (error) {
				rmSync(lockDir, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				(error as NodeJS.ErrnoException).code !== "EEXIST"
			) {
				throw error;
			}
			if (reclaimStaleConvergeLock(lockDir, timeoutMs)) continue;
			if (Date.now() - startedAt > timeoutMs) {
				throw new Error(`timed out waiting for runtime converge lock at ${lockDir}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	try {
		return await fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

export function runtimeProgramRevision(
	manifest: RuntimeManifest,
	runtime: string,
	secretValues: Record<string, string> | undefined,
	providerProjectionRevision: string | null = null,
): string {
	return revisionHash({
		clawdiCli: manifest.clawdiCli ?? null,
		controlPlane: manifest.controlPlane,
		egressProfiles: manifest.egressProfiles ?? null,
		locale: manifest.locale ?? null,
		projection: manifest.projection ?? null,
		providerProjectionRevision,
		runtime: manifest.runtimes[runtime] ?? null,
		secretValues: secretValues ?? {},
	});
}

function runtimeServiceProgramRevision(
	manifest: RuntimeManifest,
	runtime: string,
	service: string,
): string {
	return revisionHash({
		clawdiCli: manifest.clawdiCli ?? null,
		controlPlane: manifest.controlPlane,
		runtime: runtime,
		service,
		settings: manifest.runtimes[runtime]?.services?.[service] ?? null,
		timezone: manifest.locale?.timezone ?? null,
	});
}

function daemonProgramRevision(manifest: RuntimeManifest): string {
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
	egress: RuntimeEgressSystemdProgram | null;
}): RuntimeSystemdUserProgram | null {
	if (!input.config.enabled) return null;

	const currentPath = withoutPathEntry(
		runtimeSystemdPath(input.paths),
		runtimeManagedBinDir(input.paths),
	);
	const pathPrefix = input.config.prependPath.join(":");
	const env: Record<string, string> = {
		...input.config.env,
		PATH: pathPrefix ? [pathPrefix, currentPath].filter(Boolean).join(":") : currentPath,
	};
	for (const [envName, ref] of Object.entries(input.config.secretEnv)) {
		const value = runtimeSecretValue(input.secretValues ?? {}, ref);
		if (!value) {
			throw new Error(`Runtime secret ${ref} for ${envName} is unavailable.`);
		}
		env[envName] = value;
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
	};
}

export function runtimeSecretValue(secrets: Record<string, string>, ref: string): string | null {
	return resolveRuntimeSecretValue(secrets, ref);
}

function hashToUInt16(input: string): number {
	return createHash("sha256").update(input).digest().readUInt16BE(0);
}

export function runtimeSidecarProgramRevision(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	egressProgram: RuntimeEgressSystemdProgram | null = null,
	egressIdentity: RuntimeEgressIdentity | null = null,
): string {
	if (egressProgram && !egressIdentity) {
		throw new Error("runtime sidecar egress revision requires the configured numeric identity");
	}
	return revisionHash({
		clawdiCli: manifest.clawdiCli ?? null,
		bridgeSurfaces: runtimeBridgeSurfaceSpecsForManifest(manifest),
		bridgeTokenPresent: Boolean(secretValues),
		runtimeSidecar: "hosted-runtime-sidecar-v3",
		instanceId: manifest.instanceId,
		generation: manifest.generation,
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
): string {
	if (program.service)
		return runtimeServiceProgramRevision(manifest, program.runtime, program.service);
	return runtimeProgramRevision(
		manifest,
		program.runtime,
		secretValues,
		providerProjectionRevisions[program.runtime] ?? null,
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

function hostedRuntimeBridgeToken(): string {
	const direct = process.env[RUNTIME_BRIDGE_TOKEN_ENV]?.trim();
	if (direct) return direct;
	return readProcEnvironmentValue(
		process.env.CLAWDI_RUNTIME_PID1_ENVIRON_PATH?.trim() || "/proc/1/environ",
		RUNTIME_BRIDGE_TOKEN_ENV,
	);
}

function readProcEnvironmentValue(path: string, key: string): string {
	try {
		const raw = readFileSync(path);
		const prefix = `${key}=`;
		for (const part of raw.toString("utf8").split("\0")) {
			if (part.startsWith(prefix)) return part.slice(prefix.length).trim();
		}
	} catch {
		// Best effort: runtime managers can still run without hosted bridge access.
	}
	return "";
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
	mkdirSync(input.paths.systemdEnvRoot, { recursive: true });
	makeRootOwned(input.paths.systemdEnvRoot);
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
}): { envFile: string; envRevision: string } {
	return {
		envFile: writeSystemdEnvironmentFile(input),
		envRevision: revisionHash({
			systemdEnvironmentFile: "v1",
			env: input.env,
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
	unitEnv?: Record<string, string>;
	serviceType?: "simple" | "oneshot" | "notify";
	restart?: boolean;
	extraUnitLines?: string[];
	extraServiceLines?: string[];
	wantedBy: "multi-user.target" | "default.target";
}): string {
	mkdirSync(input.root, { recursive: true });
	if (input.owner === "runtime-user") makeRuntimeUserOwned(input.root);
	const path = join(input.root, systemdUnitFileName(input.name));
	const { envFile, envRevision } = writeSystemdProgramEnvironment({
		paths: input.paths,
		name: input.name,
		owner: input.owner,
		env: input.env,
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
	writePrivateFileAtomic(path, `${lines.join("\n")}`, { mode: 0o644, dirMode: 0o755 });
	if (input.owner === "runtime-user") makeRuntimeUserOwned(path);
	else makeRootOwned(path);
	return path;
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
	removeGeneratedRuntimeBaseUnit(input.paths, unitName);
	const { envFile, envRevision } = writeSystemdProgramEnvironment({
		paths: input.paths,
		name: input.name,
		owner: "runtime-user",
		env: input.env,
	});
	const path = systemdDropInFilePath(input.paths, input.name);
	mkdirSync(dirname(path), { recursive: true });
	makeRuntimeUserOwned(dirname(path));
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
	writePrivateFileAtomic(path, `${lines.join("\n")}`, { mode: 0o644, dirMode: 0o755 });
	makeRuntimeUserOwned(path);
	return join(input.paths.systemdUserRoot, unitName);
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

function runtimeManifestUrlEnv(sourcePath: string): string {
	if (/^https?:\/\//i.test(sourcePath)) return sourcePath;
	return process.env.CLAWDI_RUNTIME_MANIFEST_URL?.trim() || "";
}

function runtimeSystemdCommonEnvironment(
	sourcePath: string,
	paths: RuntimePaths,
): Record<string, string> {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	return {
		HOME: paths.userHome,
		CLAWDI_RUNTIME_MODE: "hosted",
		CLAWDI_RUNTIME_AUTH_ENV: process.env.CLAWDI_RUNTIME_AUTH_ENV?.trim() ?? "",
		CLAWDI_RUNTIME_USER: runtimeUser,
		CLAWDI_SERVICE_STATE_DIR: paths.serviceStateRoot,
		CLAWDI_RUN_DIR: paths.runRoot,
		CLAWDI_RUNTIME_MANIFEST_URL: runtimeManifestUrlEnv(sourcePath),
		[RUNTIME_BRIDGE_TOKEN_ENV]: "",
		[RUNTIME_BRIDGE_LISTEN_HOST_ENV]: process.env[RUNTIME_BRIDGE_LISTEN_HOST_ENV]?.trim() ?? "",
		[RUNTIME_BRIDGE_SURFACES_ENV]: "",
		PATH: runtimeSystemdPath(paths),
	};
}

function writeRuntimeSystemdUserProgram(input: {
	program: RuntimeSystemdUserProgram;
	commonEnvironment: Record<string, string>;
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	secretValues: Record<string, string> | undefined;
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
	return [...byServiceName.values()];
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
	providerProjectionRevisions: Partial<Record<string, string | null>>,
	commonEnvironment: Record<string, string>,
): { systemUnits: string[]; userUnits: string[] } {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	const runtimeBridgeToken = hostedRuntimeBridgeToken();
	const bridgeSurfaceSpecs = runtimeBridgeSurfaceSpecsForManifest(manifest);
	const systemUnits: string[] = [];
	const shouldRunBridge = bridgeSurfaceSpecs.length > 0;
	const shouldRunEgress = egressProgram !== null && runtimePrograms.length > 0;
	const activeEgressProgram = shouldRunEgress ? egressProgram : null;
	const activeEgressIdentity = shouldRunEgress ? egressIdentity : null;
	const shouldRunSidecar = shouldRunBridge || shouldRunEgress;
	const shouldRunDaemon =
		daemonAuthTokenFile !== null && desiredLiveSyncAgents(manifest).length > 0;
	const userUnits: string[] = [];
	const runtimeUid = shouldRunEgress ? runtimeUserUid(runtimeUser) : null;

	if (daemonAuthTokenFile) {
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-runtime-watch",
				description: "Clawdi hosted runtime desired-state watcher",
				command: "clawdi",
				args: ["runtime", "watch"],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					CLAWDI_AUTH_TOKEN: "",
					[RUNTIME_BRIDGE_TOKEN_ENV]: runtimeBridgeToken,
				},
			}),
		);
	}

	if (shouldRunDaemon && daemonAuthTokenFile) {
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-daemon",
				description: "Clawdi hosted runtime daemon",
				command: "clawdi",
				args: ["daemon", "run", "--auth-token-file", daemonAuthTokenFile],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					CLAWDI_SERVE_MODE: "container",
					CLAWDI_API_URL: manifest.controlPlane.apiUrl,
					CLAWDI_NO_AUTO_UPDATE: "1",
					CLAWDI_NO_UPDATE_CHECK: "1",
					CLAWDI_RUNTIME_REV: daemonProgramRevision(manifest),
				},
			}),
		);
	}

	if (shouldRunSidecar) {
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-runtime-sidecar",
				description: "Clawdi hosted runtime sidecar",
				command: "clawdi",
				args: ["runtime", "sidecar"],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					CLAWDI_AUTH_TOKEN: "",
					CLAWDI_EGRESS_ENV_FILE: shouldRunEgress && egressProgram ? egressProgram.envFilePath : "",
					[RUNTIME_BRIDGE_TOKEN_ENV]: shouldRunBridge ? runtimeBridgeToken : "",
					[RUNTIME_BRIDGE_SURFACES_ENV]: shouldRunBridge ? JSON.stringify(bridgeSurfaceSpecs) : "",
					CLAWDI_RUNTIME_REV: runtimeSidecarProgramRevision(
						manifest,
						secretValues,
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
				providerProjectionRevisions,
			}),
		);
	}

	removeStaleSystemdSystemUnits(paths, systemUnits);
	removeStaleSystemdUserUnits(paths, userUnits);
	removeStaleSystemdEnvironmentFiles(paths, [...systemUnits, ...userUnits]);
	return { systemUnits, userUnits };
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
	const home = projectionSystemHome(manifest) ?? paths.userHome;
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
			const settings = mergeRuntimeServiceEnvWithProviderPlaceholders(
				name,
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
	observations: Map<string, RuntimeInstallObservation>;
	egressProfileBundlePath: string | null;
	egress: RuntimeEgressSystemdProgram | null;
}): RuntimeSystemdUserProgram[] {
	const programs: RuntimeSystemdUserProgram[] = [];
	for (const [name, runtime] of Object.entries(input.manifest.runtimes).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const runtimeName = runtimeNameSchema.parse(name);
		const observation = input.observations.get(name);
		if (!observation) throw new Error(`runtime ${name} install observation is missing`);
		const providerPlaceholderEnv = runtime.enabled
			? hostedProviderPlaceholderEnv(input.manifest, name)
			: {};
		const providerSecretEnv = runtime.enabled ? hostedProviderSecretEnv(input.manifest, name) : {};
		const settings = mergeRuntimeEnvWithProviderPlaceholders(
			name,
			runtime.run,
			providerPlaceholderEnv,
		);
		const secretEnv = runtime.enabled
			? mergeRuntimeSecretEnv(name, runtime, providerSecretEnv)
			: {};
		const secretFilePath =
			Object.keys(scopedSecretValues(input.secretValues, Object.values(secretEnv))).length > 0
				? runtimeSecretFilePath(input.paths, name)
				: null;
		const runConfig = buildRuntimeRunConfig({
			runtime: runtimeName,
			enabled: runtime.enabled,
			generatedAt: input.generatedAt,
			generation: input.manifest.generation,
			instanceId: input.manifest.instanceId,
			commandPath: observation.commandPath,
			appRoot: observation.appRoot,
			workspaceRoot: input.workspaceRoot,
			egressProfileBundlePath: input.egressProfileBundlePath,
			settings,
			secretFilePath,
			secretEnv,
		});
		if (runtime.enabled && shouldRunRuntime(name, input.manifest)) {
			const program = buildRuntimeSystemdUserProgram({
				config: runConfig,
				paths: input.paths,
				secretValues: input.secretValues,
				egress: input.egress,
			});
			if (program) programs.push(program);
		}
		for (const [serviceName, serviceSettings] of Object.entries(runtime.services ?? {})) {
			const service = runtimeServiceNameSchema.parse(serviceName);
			const serviceRunSettings = mergeRuntimeServiceEnvWithProviderPlaceholders(
				name,
				service,
				serviceSettings,
				providerPlaceholderEnv,
			);
			const serviceSecretEnv = runtime.enabled
				? mergeRuntimeServiceSecretEnv(name, service, serviceRunSettings, secretEnv)
				: {};
			const serviceRunConfig = buildRuntimeRunConfig({
				runtime: runtimeName,
				service,
				enabled: runtime.enabled,
				generatedAt: input.generatedAt,
				generation: input.manifest.generation,
				instanceId: input.manifest.instanceId,
				commandPath: observation.commandPath,
				appRoot: observation.appRoot,
				workspaceRoot: input.workspaceRoot,
				settings: serviceRunSettings,
				secretFilePath: null,
				secretEnv: serviceSecretEnv,
			});
			const program = buildRuntimeSystemdUserProgram({
				config: serviceRunConfig,
				paths: input.paths,
				secretValues: input.secretValues,
				egress: input.egress,
			});
			if (program) programs.push(program);
		}
	}
	return programs;
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

function addExistingManagedSystemdPaths(paths: RuntimePaths, result: Set<string>): void {
	for (const root of [paths.systemdSystemRoot, paths.systemdUserRoot]) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root)) {
			const path = join(root, entry);
			if (
				entry.endsWith(".service") &&
				(entry.startsWith("clawdi-") || isGeneratedSystemdFile(path))
			) {
				result.add(path);
			}
			if (!entry.endsWith(".service.d")) continue;
			const dropIn = join(path, "10-clawdi-hosted.conf");
			if (isGeneratedSystemdFile(dropIn)) result.add(dropIn);
		}
	}
	const wantsRoot = join(paths.systemdUserRoot, "default.target.wants");
	if (existsSync(wantsRoot)) {
		for (const entry of readdirSync(wantsRoot)) {
			const path = join(wantsRoot, entry);
			if (entry.startsWith("clawdi-") || isGeneratedSystemdFile(path)) result.add(path);
		}
	}
}

function addManagedWhatsAppSnapshotPaths(manifest: RuntimeManifest, result: Set<string>): void {
	for (const credential of hostedWhatsAppAuthCredentials(manifest)) result.add(credential.authDir);
	for (const root of Object.values(managedWhatsAppAuthRoots(manifest))) {
		if (!root || !existsSync(root)) continue;
		for (const entry of readdirSync(root)) {
			const authDir = join(root, entry);
			if (readManagedWhatsAppAuthMarker(authDir)) result.add(authDir);
		}
	}
}

export function runtimeLiveSnapshotPaths(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	workspaceRoot: string,
): string[] {
	const home = projectionSystemHome(manifest) ?? paths.userHome;
	const result = new Set<string>([
		paths.managedConfig,
		paths.syncState,
		paths.providerHealthStatus,
		paths.egressEngineStatus,
		paths.manifestLastGood,
		paths.managedSecretCacheFile,
		paths.appliedState,
		paths.runConfigRoot,
		paths.egressProfileRoot,
		paths.installInventory,
		paths.projectionRoot,
		join(paths.instanceRoot, manifest.instanceId),
		paths.managedSecretRoot,
		paths.egressRoot,
		paths.egressScratchRoot,
		paths.systemdEnvRoot,
		paths.instanceData,
		paths.sensitiveInstanceData,
		liveSyncEnvironmentIndexPath(paths),
		join(workspaceRoot, "SOUL.md"),
		join(home, ".openclaw", "openclaw.json"),
		join(home, ".hermes", "config.yaml"),
		join(home, ".hermes", "SOUL.md"),
		hermesModelProviderPluginDir(home),
		join(hostedCodexHome(home), CODEX_MANAGED_PROVIDER_CONFIG_FILE),
	]);
	for (const agent of MANAGED_LIVE_SYNC_AGENTS) {
		result.add(join(paths.localEnvironments, `${agent}.json`));
	}
	for (const name of ["clawdi-runtime-watch", "clawdi-daemon", "clawdi-runtime-sidecar"]) {
		result.add(join(paths.systemdSystemRoot, systemdUnitFileName(name)));
	}
	for (const [runtime, settings] of Object.entries(manifest.runtimes)) {
		const names = [
			runtimeServiceProgramName(runtime, "gateway"),
			`clawdi-${systemdUnitNameSegment(runtime)}`,
			...Object.keys(settings.services ?? {}).map((service) =>
				runtimeServiceProgramName(runtime, service),
			),
		];
		for (const name of names) {
			const unit = systemdUnitFileName(name);
			result.add(join(paths.systemdUserRoot, unit));
			result.add(join(paths.systemdUserRoot, `${unit}.d`, "10-clawdi-hosted.conf"));
			result.add(join(paths.systemdUserRoot, "default.target.wants", unit));
		}
	}
	addExistingManagedSystemdPaths(paths, result);
	addManagedWhatsAppSnapshotPaths(manifest, result);
	return [...result].sort();
}

function runtimeLiveSnapshotMetadataPaths(snapshotPaths: readonly string[]): string[] {
	return [
		...new Set(
			snapshotPaths
				.filter((path) => basename(path) === "10-clawdi-hosted.conf")
				.map((path) => dirname(path)),
		),
	].sort();
}

function captureRuntimeLiveNode(path: string): RuntimeLiveSnapshotNode {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw error;
	}
	if (stat.isSymbolicLink()) {
		return { kind: "symlink", target: readlinkSync(path), uid: stat.uid, gid: stat.gid };
	}
	if (stat.isFile()) {
		return {
			kind: "file",
			content: readFileSync(path),
			mode: stat.mode & 0o777,
			uid: stat.uid,
			gid: stat.gid,
		};
	}
	if (!stat.isDirectory()) throw new Error(`unsupported runtime live-state path: ${path}`);
	return {
		kind: "directory",
		mode: stat.mode & 0o777,
		uid: stat.uid,
		gid: stat.gid,
		entries: new Map(
			readdirSync(path)
				.sort()
				.map((entry) => [entry, captureRuntimeLiveNode(join(path, entry))]),
		),
	};
}

function captureRuntimeLiveMetadata(path: string): RuntimeLiveSnapshotNode {
	try {
		const stat = lstatSync(path);
		return {
			kind: "metadata",
			existed: true,
			mode: stat.mode & 0o777,
			uid: stat.uid,
			gid: stat.gid,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "metadata", existed: false };
		}
		throw error;
	}
}

function restoreRuntimeLiveOwnership(
	path: string,
	uid: number,
	gid: number,
	symlink: boolean,
): void {
	const restored = lstatSync(path);
	if (restored.uid === uid && restored.gid === gid) return;
	if (symlink) lchownSync(path, uid, gid);
	else chownSync(path, uid, gid);
}

function captureRuntimeLiveSnapshot(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	workspaceRoot: string,
): RuntimeLiveSnapshot {
	const snapshotPaths = runtimeLiveSnapshotPaths(manifest, paths, workspaceRoot);
	return {
		entries: new Map([
			...snapshotPaths.map((path) => [path, captureRuntimeLiveNode(path)] as const),
			...runtimeLiveSnapshotMetadataPaths(snapshotPaths).map(
				(path) => [path, captureRuntimeLiveMetadata(path)] as const,
			),
		]),
	};
}

function restoreRuntimeLiveNode(path: string, node: RuntimeLiveSnapshotNode): void {
	if (node.kind === "metadata") {
		if (!node.existed) {
			if (existsSync(path) && readdirSync(path).length === 0) rmSync(path, { recursive: true });
			return;
		}
		if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: node.mode });
		chmodSync(path, node.mode);
		restoreRuntimeLiveOwnership(path, node.uid, node.gid, false);
		return;
	}
	rmSync(path, { recursive: true, force: true });
	if (node.kind === "missing") return;
	mkdirSync(dirname(path), { recursive: true });
	if (node.kind === "symlink") {
		symlinkSync(node.target, path);
		restoreRuntimeLiveOwnership(path, node.uid, node.gid, true);
		return;
	}
	if (node.kind === "file") {
		writeFileSync(path, node.content, { mode: node.mode });
		chmodSync(path, node.mode);
		restoreRuntimeLiveOwnership(path, node.uid, node.gid, false);
		return;
	}
	mkdirSync(path, { recursive: true, mode: node.mode });
	chmodSync(path, node.mode);
	for (const [entry, child] of node.entries) restoreRuntimeLiveNode(join(path, entry), child);
	restoreRuntimeLiveOwnership(path, node.uid, node.gid, false);
}

function restoreRuntimeLiveSnapshot(snapshot: RuntimeLiveSnapshot): void {
	for (const [path, node] of snapshot.entries) {
		if (node.kind !== "metadata") restoreRuntimeLiveNode(path, node);
	}
	for (const [path, node] of snapshot.entries) {
		if (node.kind === "metadata") restoreRuntimeLiveNode(path, node);
	}
}

function validateRuntimeProjectionPlan(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	workspaceRoot: string;
	secretValues: Record<string, string> | undefined;
	observations: Map<string, RuntimeInstallObservation>;
	previousProjectedProviderIds: Record<string, string[]>;
	managedPrimaryModelOverrides?: Partial<Record<string, AgentPrimaryModel>>;
}): void {
	const {
		manifest,
		paths,
		workspaceRoot,
		secretValues,
		observations,
		previousProjectedProviderIds,
		managedPrimaryModelOverrides,
	} = input;
	const home = projectionSystemHome(manifest) ?? paths.userHome;
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
			const settings = mergeRuntimeServiceEnvWithProviderPlaceholders(
				name,
				service,
				serviceSettings,
				providerPlaceholderEnv,
			);
			mergeRuntimeServiceSecretEnv(name, service, settings, secretEnv);
		}

		const projectionInput = agentTargetProjectionInput(
			hostedAiProviderCatalog(manifest, name, {
				primaryModelOverride: managedPrimaryModelOverrides?.[name],
			}),
		);
		assertHostedProviderProjectionMode(name, manifest, projectionInput);
		const configuredProjectionUnavailable =
			manifest.runtimes[name]?.providerMode === "configured" && !projectionInput;
		const projectionRequiresInstalledModelProbe =
			projectionInput?.catalog.providers.some((provider) => provider.managed_by === "clawdi") &&
			managedPrimaryModelOverrides === undefined;
		if (name === "openclaw") {
			if (projectionInput && !projectionRequiresInstalledModelProbe) {
				const projection = buildAgentTargetProjection(
					"openclaw",
					projectionInput.catalog,
					projectionInput.primaryModel,
				);
				const file = projection.files.find((entry) => entry.path.endsWith(".openclaw.json"));
				if (!file) throw new Error("OpenClaw projection did not include a config patch JSON file.");
				mergeOpenClawProviderDeletes(
					file.content,
					staleProviderIds(
						new Set(previousProjectedProviderIds.openclaw ?? []),
						openClawProviderIdsFromPatch(file.content),
					),
				);
			} else if (!configuredProjectionUnavailable) {
				JSON.stringify(openClawProviderDeletePatch(previousProjectedProviderIds.openclaw ?? []));
			}
			JSON.stringify(openClawGatewayHostedPatch(manifest));
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
				buildHermesHostedProviderPluginProjection(
					projectionInput.catalog,
					projectionInput.primaryModel,
				);
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

		if (hostedMcpProjectionDeclared(manifest) && name === "hermes") {
			hermesConfig = hostedMcpProjectionEnabled(manifest)
				? renderHermesMcpServer(
						hermesConfig,
						"clawdi",
						hostedMcpServerConfig(manifest, paths.daemonAuthToken),
					)
				: renderHermesMcpServerRemoval(hermesConfig, "clawdi");
		}
		if (hostedMcpProjectionDeclared(manifest) && name === "openclaw") {
			JSON.stringify(
				hostedMcpProjectionEnabled(manifest)
					? hostedMcpServerConfig(manifest, paths.daemonAuthToken)
					: { remove: "clawdi" },
			);
		}
	}
	validateHostedChannelCredentialsPlan(manifest, secretValues);
}

export function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: {
		cacheLastGood?: boolean;
		commitAuthority?: (convergence: RuntimeConvergenceResult) => void;
		managedGatewayModelListFetcher?: ManagedGatewayModelListFetcher;
		systemdApply?: RuntimeSystemdApplyHooks;
	} = {},
): RuntimeConvergenceResult {
	const { manifest } = load;
	const secretValues = runtimeSecretValues(load);
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
	const previousProjectedProviderIds = appliedState?.projectedProviderIds ?? {};
	const projectedProviderIds: Record<string, string[]> = {};
	const runtimeEntries = Object.entries(manifest.runtimes).sort(([a], [b]) => a.localeCompare(b));
	const observations = new Map<string, RuntimeInstallObservation>();

	validateRuntimeManifestPlan(manifest, paths);
	for (const [name, runtime] of runtimeEntries) {
		const observation = planRuntimeInstallObservation(name, runtime);
		observations.set(name, observation);
		if (observation.error) installErrors.push(observation.error);
	}
	validateRuntimeProjectionPlan({
		manifest,
		paths,
		workspaceRoot,
		secretValues,
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
		observations,
		egressProfileBundlePath: plannedEgressProfileBundlePath,
		egress: null,
	});
	validateRuntimeSystemdProgramsPlan(plannedRuntimePrograms);
	observations.clear();
	for (const [name, runtime] of runtimeEntries) {
		const observation = observeRuntimeInstall(name, runtime);
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
			installHostedChannelProjectionDependencies(name, observation, manifest, paths.userHome);
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
	const managedPrimaryModelOverrides = resolveManagedGatewayPrimaryModelOverrides(
		manifest,
		enabledRuntimes,
		paths.userHome,
		workspaceRoot,
		plannedEgressProfileBundlePath ? paths.egressSystemCaFile : null,
		opts.managedGatewayModelListFetcher ?? fetchManagedGatewayModelList,
	);
	validateRuntimeProjectionPlan({
		manifest,
		paths,
		workspaceRoot,
		secretValues,
		observations,
		previousProjectedProviderIds,
		managedPrimaryModelOverrides,
	});

	const workspaceExistedBeforeApply = existsSync(workspaceRoot);
	const liveSnapshot = captureRuntimeLiveSnapshot(manifest, paths, workspaceRoot);
	let systemdActivationAttempted = false;
	try {
		const plannedUserUnits = plannedRuntimePrograms.map((program) =>
			join(paths.systemdUserRoot, systemdUnitFileName(runtimeSystemdProgramName(program))),
		);
		for (const unitName of staleOfficialRuntimeUserServices(paths, plannedUserUnits)) {
			const error = uninstallOfficialRuntimeUserService({ unitName, paths, workspaceRoot });
			if (error) throw new Error(error);
		}

		mkdirSync(workspaceRoot, { recursive: true });
		makeRuntimeUserOwned(paths.userHome);
		makeRuntimeUserPrivateDir(paths.clawdiHome);
		makeRuntimeUserOwned(workspaceRoot);
		mkdirSync(paths.installInventory, { recursive: true });
		mkdirSync(paths.projectionRoot, { recursive: true });
		mkdirSync(semRoot, { recursive: true });
		mkdirSync(paths.managedSecretRoot, { recursive: true });
		makeManagedSecretRoot(paths.managedSecretRoot);
		makeRootReadableDir(paths.egressProfileRoot);
		makeRootReadableDir(paths.egressRoot);
		makeEgressIdentityPrivateDir(paths.egressCaDir);
		makeRootReadableDir(dirname(paths.egressSystemCaFile));
		makeRuntimeUserPrivateDir(paths.egressScratchRoot);

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
			tokenSource: process.env.CLAWDI_AUTH_TOKEN ? "CLAWDI_AUTH_TOKEN" : load.source,
			token: "<redacted>",
		});

		const egressProfileBundlePath = hasEnabledEgressProfiles(egressProfileBundle)
			? writeEgressProfileBundle(egressProfileBundle, paths)
			: clearEgressProfileBundle(paths);
		const egressEngine = writeEgressEngineStatus(
			egressProfileBundlePath ? ensureRuntimeMitmproxy(manifest.egressEngine, paths) : null,
			paths,
		);
		const egressAddon = egressProfileBundlePath ? writeEgressAddon(paths) : clearEgressAddon(paths);
		const daemonAuthTokenFile = writeDaemonAuthToken(paths);
		writeSecretValues(secretValues, paths, egressSidecarOnlySecretRefs(manifest));
		try {
			materializeHostedChannelCredentials(manifest, secretValues);
		} catch (error) {
			installErrors.push(
				`runtime channel credential materialization failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const egressSecretFile = writeEgressSecretFile(manifest, secretValues, paths);
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
		const egressUid = egressSystemdProgram ? runtimeEgressUid() : 0;
		const egressGid = egressSystemdProgram ? runtimeEgressGid() : 0;
		const egressIdentity = egressSystemdProgram ? { runtimeUid, egressUid, egressGid } : null;
		const egressTransparentEnv = writeTransparentEgressEnvFile({
			program: egressSystemdProgram,
			paths,
			runtimeUser,
			runtimeUid,
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
		const providerProjectionRevisions: Partial<Record<string, string | null>> = {};
		for (const [name] of runtimeEntries) {
			const observation = observations.get(name);
			if (!observation) throw new Error(`runtime ${name} install observation is missing`);
			providerProjectionRevisions[name] = previewHostedAiProviderProjectionRevision(
				name,
				observation,
				manifest,
				workspaceRoot,
				previousProjectedProviderIds[name] ?? [],
				managedPrimaryModelOverrides,
			);
		}
		const commonSystemdEnvironment = runtimeSystemdCommonEnvironment(load.sourcePath, paths);
		if (shouldInstallOfficialRuntimeServices()) {
			for (const program of officialRuntimeSystemdPrograms(runtimeSystemdUserPrograms)) {
				writeRuntimeSystemdUserProgram({
					program,
					commonEnvironment: commonSystemdEnvironment,
					manifest,
					paths,
					secretValues,
					providerProjectionRevisions,
				});
				reloadRuntimeUserManager(paths, paths.userHome);
				const error = installOfficialRuntimeUserService({ ...program, cwd: paths.userHome }, paths);
				if (error) throw new Error(error);
			}
		}
		try {
			const codexProjection = applyHostedCodexManagedProviderProjection(
				manifest,
				projectionSystemHome(manifest) ?? paths.userHome,
				codexCli,
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
				const localeFile = applyHostedLocaleProjection(
					name,
					manifest,
					projectionSystemHome(manifest) ?? paths.userHome,
					workspaceRoot,
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
					workspaceRoot,
					previousProjectedProviderIds[name] ?? [],
					managedPrimaryModelOverrides,
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
				applyHostedChannelProjection(name, observation, manifest, workspaceRoot);
			} catch (error) {
				installErrors.push(
					`runtime ${name} channel projection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			try {
				applyHostedMcpProjection(name, observation, manifest, workspaceRoot, daemonAuthTokenFile);
			} catch (error) {
				installErrors.push(
					`runtime ${name} mcp projection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			if (installErrors.length > 0) {
				throw new Error(installErrors.join("; "));
			}
			const runtimeName = runtimeNameSchema.parse(name);
			const providerPlaceholderEnv = runtime.enabled
				? hostedProviderPlaceholderEnv(manifest, name)
				: {};
			const providerSecretEnv = runtime.enabled ? hostedProviderSecretEnv(manifest, name) : {};
			assertNoProviderEnvOverlap(name, providerPlaceholderEnv, providerSecretEnv);
			const runtimeRunSettings = mergeRuntimeEnvWithProviderPlaceholders(
				name,
				runtime.run,
				providerPlaceholderEnv,
			);
			const secretEnv = runtime.enabled
				? mergeRuntimeSecretEnv(name, runtime, providerSecretEnv)
				: {};
			const runtimeProviderSecretFile = writeRuntimeProviderSecretFile(
				name,
				secretValues,
				secretEnv,
				paths,
			);
			if (runtimeProviderSecretFile) writtenRuntimeSecretIds.add(name);
			const runConfig = buildRuntimeRunConfig({
				runtime: runtimeName,
				enabled: runtime.enabled,
				generatedAt,
				generation: manifest.generation,
				instanceId: manifest.instanceId,
				commandPath: observation.commandPath,
				appRoot: observation.appRoot,
				workspaceRoot,
				egressProfileBundlePath,
				settings: runtimeRunSettings,
				secretFilePath: runtimeProviderSecretFile,
				secretEnv,
			});
			const runConfigPath = writeRuntimeRunConfig(runConfig, paths);
			runConfigs.push(runConfigPath);
			writtenRunConfigIds.add(runtimeRunConfigId(runtimeName));
			for (const [serviceName, serviceSettings] of Object.entries(runtime.services ?? {})) {
				const service = runtimeServiceNameSchema.parse(serviceName);
				const serviceRunSettings = mergeRuntimeServiceEnvWithProviderPlaceholders(
					name,
					service,
					serviceSettings,
					providerPlaceholderEnv,
				);
				const serviceSecretEnv = runtime.enabled
					? mergeRuntimeServiceSecretEnv(name, service, serviceRunSettings, secretEnv)
					: {};
				const serviceRunConfig = buildRuntimeRunConfig({
					runtime: runtimeName,
					service,
					enabled: runtime.enabled,
					generatedAt,
					generation: manifest.generation,
					instanceId: manifest.instanceId,
					commandPath: observation.commandPath,
					appRoot: observation.appRoot,
					workspaceRoot,
					settings: serviceRunSettings,
					secretFilePath: null,
					secretEnv: serviceSecretEnv,
				});
				const serviceRunConfigPath = writeRuntimeRunConfig(serviceRunConfig, paths);
				runConfigs.push(serviceRunConfigPath);
				writtenRunConfigIds.add(runtimeRunConfigId(runtimeName, service));
			}

			const semaphorePath = join(semRoot, `${name}.enabled`);
			if (runtime.enabled) {
				writePrivateFileAtomic(semaphorePath, `${generatedAt}\n`);
				instanceSemaphores.push(semaphorePath);
			}
		}

		const mcpProjection = join(paths.projectionRoot, "clawdi-mcp.json");
		if (hostedMcpProjectionDeclared(manifest)) {
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
			providerProjectionRevisions,
			commonSystemdEnvironment,
		);

		const bootFinished = join(instanceRoot, "boot-finished");
		writePrivateFileAtomic(bootFinished, `${generatedAt}\n`);
		removeStaleRuntimeRunConfigs(writtenRunConfigIds, paths);
		removeStaleRuntimeSecretFiles(writtenRuntimeSecretIds, paths);
		if (opts.systemdApply) {
			systemdActivationAttempted = true;
			opts.systemdApply.activate();
		}
		if (installErrors.length === 0 && opts.cacheLastGood !== false) {
			manifestLastGood = writeLastGoodManifest(
				load.sourceManifest ?? manifest,
				paths,
				load.secretValues,
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
		if (installErrors.length === 0) opts.commitAuthority?.(convergence);
		return convergence;
	} catch (error) {
		const applyError = error instanceof Error ? error.message : String(error);
		try {
			restoreRuntimeLiveSnapshot(liveSnapshot);
		} catch (rollbackError) {
			installErrors.push(
				`runtime filesystem rollback failed: ${
					rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
				}`,
			);
		}
		if (!workspaceExistedBeforeApply && existsSync(workspaceRoot)) {
			try {
				if (readdirSync(workspaceRoot).length === 0) rmSync(workspaceRoot, { recursive: true });
			} catch (rollbackError) {
				installErrors.push(
					`runtime workspace rollback failed: ${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
		}
		if (systemdActivationAttempted && opts.systemdApply) {
			try {
				opts.systemdApply.rollback();
			} catch (rollbackError) {
				installErrors.push(
					`runtime systemd rollback failed: ${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
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
