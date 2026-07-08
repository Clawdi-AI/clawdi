import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	chownSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AiProviderApiMode,
	AiProviderAuth,
	AiProviderCatalog,
	AiProviderType,
} from "@clawdi/shared";
import { isAiProviderApiMode, isAiProviderType } from "@clawdi/shared";
import { z } from "zod";
import { type AgentPrimaryModel, buildAgentTargetProjection } from "../lib/ai-provider-projection";
import {
	mergeHermesChannelConfig,
	mergeHermesConfig,
	mergeHermesMcpServer,
	removeHermesMcpServer,
} from "../lib/hermes-config-merge";
import { writePrivateFileAtomic } from "../lib/private-file";
import { normalizeSecretRef } from "./hosted-mitm-profiles";
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
import type { RuntimeManifestLoad } from "./manifest-source";
import { applyMitmSidecarRuntimeEnv } from "./mitm-env";
import {
	buildMitmProfileBundle,
	hasEnabledMitmProfiles,
	writeMitmProfileBundle,
} from "./mitm-profiles";
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
import { WHATSAPP_UPSTREAM_READY } from "./whatsapp-gate";

export interface RuntimeConvergenceResult {
	manifest: RuntimeManifest;
	source: RuntimeManifestLoad["source"];
	sourcePath: string;
	offline: boolean;
	mode: "normal" | "degraded-offline";
	enabledRuntimes: string[];
	installErrors: string[];
	outputs: {
		processManager: "systemd";
		workspaceRoot: string;
		managedConfig: string;
		syncState: string;
		instanceData: string;
		sensitiveInstanceData: string;
		manifestLastGood: string | null;
		installInventory: string[];
		projections: string[];
		runConfigs: string[];
		systemdSystemUnitRoot: string;
		systemdSystemUnits: string[];
		systemdUserUnitRoot: string;
		systemdUserUnits: string[];
		mitmProfileBundle: string | null;
		mitmSecretFile: string | null;
		liveSyncEnvironments: string[];
		daemonAuthTokenFile: string | null;
		instanceSemaphores: string[];
		bootFinished: string;
	};
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
	writeLastGoodSecretValues(secretValues, paths);
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
): void {
	const normalized = normalizeSecretValues(secretValues);
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
): string | null {
	const path = paths.managedSecretFile;
	const legacyPath = join(paths.runRoot, "mitm", "secrets.json");
	const normalized = normalizeSecretValues(secretValues);
	if (Object.keys(normalized).length === 0) {
		rmSync(path, { force: true });
		rmSync(legacyPath, { force: true });
		return null;
	}
	rmSync(legacyPath, { force: true });
	writePrivateFileAtomic(path, `${JSON.stringify(normalized, null, 2)}\n`, {
		mode: 0o600,
		dirMode: 0o700,
	});
	makeManagedSecretRoot(dirname(path));
	makeRootOwned(path);
	return path;
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
	owner: "root" | "runtime-user",
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
	const apiMode = stringValue(provider.apiMode) ?? stringValue(provider.api_mode);
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
	if (!runningAsRoot()) return;
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (!runtimeUser || runtimeUser === "root") return;
	const result = spawnSync("id", ["-u", runtimeUser], { encoding: "utf8" });
	const group = spawnSync("id", ["-g", runtimeUser], { encoding: "utf8" });
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

function runtimeInstallerEnv(install: RuntimeInstall): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: install.home };
	delete env.NPM_CONFIG_PREFIX;
	delete env.npm_config_prefix;
	delete env.NPM_CONFIG_CACHE;
	delete env.npm_config_cache;
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
			return {
				runtime: name,
				enabled: true,
				status: "configured",
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

function hostedAiProviderCatalog(
	manifest: RuntimeManifest,
	runtimeName?: string,
): { catalog: AiProviderCatalog; primaryModel: AgentPrimaryModel } | null {
	const providers = manifest.projection?.providers;
	if (!providers || Object.keys(providers).length === 0) return null;
	const rawEntries = hostedProviderEntries(providers, runtimeName, manifest);
	const primaryModel = hostedRuntimePrimaryModel(manifest, runtimeName, rawEntries);
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
	const runtime = manifest?.runtimes?.[runtimeName];
	if (runtime) {
		const providerIds = runtime.provider_ids?.filter((id) => Object.hasOwn(providers, id));
		if (providerIds && providerIds.length > 0) {
			return providerIds.map((providerId) => [providerId, providers[providerId]]);
		}
	}
	if (Object.hasOwn(providers, runtimeName)) {
		return [[runtimeName, providers[runtimeName]]];
	}
	if (Object.hasOwn(providers, "default")) {
		return [["default", providers.default]];
	}
	return [];
}

function hostedRuntimePrimaryModel(
	manifest: RuntimeManifest,
	runtimeName: string | undefined,
	rawEntries: Array<[string, unknown]>,
): AgentPrimaryModel | null {
	const runtime = runtimeName ? manifest.runtimes[runtimeName] : undefined;
	const primary = runtime?.primary_model;
	if (primary) return primary;
	for (const [providerId, raw] of rawEntries) {
		const provider = recordValue(raw);
		const model = provider ? stringValue(provider.model) : null;
		if (model) return { provider_id: providerId, model };
	}
	const firstProvider = rawEntries[0];
	if (!firstProvider) return null;
	const provider = recordValue(firstProvider[1]);
	const model = hostedProviderModels(provider ?? {}, null)[0]?.id;
	return model ? { provider_id: firstProvider[0], model } : null;
}

function hostedProviderModels(
	input: Record<string, unknown>,
	primaryModel: AgentPrimaryModel | null,
): NonNullable<AiProviderCatalog["providers"][number]["models"]> {
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
	const legacyModel = stringValue(input.model);
	if (legacyModel && !models.some((model) => model.id === legacyModel)) {
		models.unshift({ id: legacyModel, api_mode: hostedProviderApiMode(input) });
	}
	if (primaryModel && !models.some((model) => model.id === primaryModel.model)) {
		models.unshift({ id: primaryModel.model, api_mode: hostedProviderApiMode(input) });
	}
	return models.filter(
		(model, index, entries) => entries.findIndex((entry) => entry.id === model.id) === index,
	);
}

function hostedProviderApiMode(input: Record<string, unknown>): AiProviderApiMode {
	const raw = typeof input.apiMode === "string" ? input.apiMode : input.api_mode;
	if (typeof raw === "string" && isAiProviderApiMode(raw)) {
		return raw;
	}
	return "openai_chat";
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
		if ((type === "api_key" || type === "secret_ref") && !hasApiKeySecretRef) {
			return null;
		}
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
	const raw =
		typeof input.runtimeEnvName === "string"
			? input.runtimeEnvName
			: typeof input.runtime_env_name === "string"
				? input.runtime_env_name
				: null;
	if (raw && isEnvKey(raw)) return raw;
	return `CLAWDI_PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function hostedProviderSecretEnv(
	manifest: RuntimeManifest,
	runtimeName?: string,
): Record<string, string> {
	const providers = recordValue(manifest.projection?.providers);
	if (!providers) return {};
	const env: Record<string, string> = {};
	for (const [providerId, raw] of hostedProviderEntries(providers, runtimeName, manifest)) {
		const provider = recordValue(raw);
		if (!provider) continue;
		const apiKeySecretRef = stringValue(provider.apiKeySecretRef);
		if (!apiKeySecretRef) continue;
		const runtimeEnvName = hostedProviderRuntimeEnvName(providerId, provider);
		if (!isEnvKey(runtimeEnvName)) continue;
		env[runtimeEnvName] = normalizeSecretRef(apiKeySecretRef) ?? apiKeySecretRef;
	}
	return env;
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

function mitmSecretFilePath(paths: RuntimePaths): string {
	return join(paths.managedSecretRoot, "mitm-secrets.json");
}

function writeMitmSecretFile(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	paths: RuntimePaths,
): string | null {
	return writeScopedSecretValues(
		mitmSecretFilePath(paths),
		secretValues,
		mitmSecretRefs(manifest),
		paths,
		"runtime-user",
	);
}

function mitmSecretRefs(manifest: RuntimeManifest): string[] {
	const refs = new Set<string>();
	collectSecretRefs(manifest.mitmProfiles, refs);
	return [...refs].sort();
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

function applyHostedAiProviderProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	workspaceRoot: string,
): string | null {
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return null;
	}
	const projectionInput = hostedAiProviderCatalog(manifest, name);
	if (!projectionInput) return null;
	const home = projectionSystemHome(manifest) ?? process.env.HOME ?? "";
	if (name === "hermes") {
		const projection = buildAgentTargetProjection(
			"hermes",
			projectionInput.catalog,
			projectionInput.primaryModel,
		);
		const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
		if (!file) throw new Error("Hermes projection did not include a config merge YAML file.");
		const configPath = join(home, ".hermes", "config.yaml");
		mergeHermesConfig(configPath, file.content);
		makeRuntimeUserOwned(configPath);
		return configPath;
	}
	if (name === "openclaw") {
		applyOpenClawHostedProviderProjection(
			observation.commandPath,
			projectionInput,
			home,
			workspaceRoot,
		);
		applyOpenClawGatewayHostedProjection(observation.commandPath, manifest, home, workspaceRoot);
		return observation.commandPath;
	}
	return null;
}

function applyOpenClawHostedProviderProjection(
	command: string,
	projectionInput: {
		catalog: AiProviderCatalog;
		primaryModel: AgentPrimaryModel;
	},
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
	runRuntimeUserCommand(command, ["config", "patch", "--stdin"], file.content, home, workspaceRoot);
}

function applyOpenClawHostedProjectionAfterOfficialInstall(
	command: string,
	manifest: RuntimeManifest,
	home: string,
	workspaceRoot: string,
): void {
	const projectionInput = hostedAiProviderCatalog(manifest, "openclaw");
	if (projectionInput) {
		applyOpenClawHostedProviderProjection(command, projectionInput, home, workspaceRoot);
	}
	applyOpenClawGatewayHostedProjection(command, manifest, home, workspaceRoot);
}

function openClawGatewayHostedPatch(manifest: RuntimeManifest): Record<string, unknown> | null {
	const allowedOrigins = openClawControlUiAllowedOrigins(manifest);
	const gatewayToken = process.env[OPENCLAW_GATEWAY_TOKEN_ENV]?.trim();
	if (allowedOrigins.length === 0 && !gatewayToken) return null;
	return {
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
							dangerouslyDisableDeviceAuth: true,
						},
					}
				: {}),
		},
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
	installOpenClawChannelPlugins(observation.commandPath, channels, home, workspaceRoot);
	runRuntimeUserCommand(
		observation.commandPath,
		["config", "patch", "--stdin"],
		`${JSON.stringify(openClawManagedChannelsPatch(channels), null, 2)}\n`,
		home,
		workspaceRoot,
	);
	return observation.commandPath;
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

function runRuntimeUserCommand(
	command: string,
	args: string[],
	stdin: string,
	home: string,
	cwd: string,
): void {
	const env = {
		...process.env,
		HOME: home,
		PATH: [join(home, ".local", "bin"), join(home, ".openclaw", "bin"), process.env.PATH]
			.filter(Boolean)
			.join(":"),
	};
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

function clearMitmProfileBundle(paths: RuntimePaths): null {
	rmSync(paths.mitmProfileBundle, { force: true });
	return null;
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
	const path = paths.daemonAuthToken;
	const legacyPath = join(paths.runRoot, "sync", "auth-token");
	const token = process.env.CLAWDI_AUTH_TOKEN?.trim();
	if (!token) {
		if (existsSync(path)) return path;
		rmSync(path, { force: true });
		rmSync(legacyPath, { force: true });
		return null;
	}
	rmSync(legacyPath, { force: true });
	writePrivateFileAtomic(path, `${token}\n`, { mode: 0o600, dirMode: 0o700 });
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

function writeConvergeLockOwner(lockDir: string): void {
	writeFileSync(
		convergeLockOwnerPath(lockDir),
		`${JSON.stringify({
			schemaVersion: "clawdi.runtimeConvergeLockOwner.v1",
			pid: process.pid,
			acquiredAt: new Date().toISOString(),
		})}\n`,
		{ mode: 0o600 },
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

export function runtimeProgramRevision(
	manifest: RuntimeManifest,
	runtime: string,
	secretValues: Record<string, string> | undefined,
): string {
	return revisionHash({
		clawdiCli: manifest.clawdiCli ?? null,
		controlPlane: manifest.controlPlane,
		mitmProfiles: manifest.mitmProfiles ?? null,
		projection: manifest.projection ?? null,
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

interface RuntimeMitmSystemdProgram {
	profileBundlePath: string;
	proxyUrl: string;
	caFile: string;
	secretFilePath: string | null;
}

function runtimeMitmSystemdProgram(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	profileBundlePath: string | null,
	secretFilePath: string | null,
): RuntimeMitmSystemdProgram | null {
	if (!profileBundlePath) return null;
	const port = 18_080 + (hashToUInt16(`${manifest.instanceId}:${paths.serviceStateRoot}`) % 20_000);
	return {
		profileBundlePath,
		proxyUrl: `http://127.0.0.1:${port}`,
		caFile: join(paths.runRoot, "mitm", "systemd", "ca.pem"),
		secretFilePath,
	};
}

function buildRuntimeSystemdUserProgram(input: {
	config: RuntimeRunConfig;
	paths: RuntimePaths;
	secretValues: Record<string, string> | undefined;
	mitm: RuntimeMitmSystemdProgram | null;
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
	if (input.mitm) {
		applyMitmSidecarRuntimeEnv(env, {
			proxyUrl: input.mitm.proxyUrl,
			caFile: input.mitm.caFile,
		});
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
): string {
	return revisionHash({
		clawdiCli: manifest.clawdiCli ?? null,
		bridgeSurfaces: runtimeBridgeSurfaceSpecsForManifest(manifest),
		mitmProfiles: manifest.mitmProfiles ?? null,
		secretValues: secretValues ?? {},
		runtimeSidecar: "hosted-runtime-sidecar-v1",
	});
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
): string {
	if (program.service)
		return runtimeServiceProgramRevision(manifest, program.runtime, program.service);
	return runtimeProgramRevision(manifest, program.runtime, secretValues);
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
		installArgs: ["gateway", "install"],
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
		"",
		"[Service]",
		`# ClawdiEnvironmentRevision=${envRevision}`,
		"Type=simple",
		`WorkingDirectory=${systemdPath(input.cwd)}`,
		...(input.unitEnv ? systemdUnitEnvironmentLines(input.unitEnv) : []),
		...(input.extraServiceLines ?? []),
		`EnvironmentFile=${systemdPath(envFile)}`,
		`ExecStart=${systemdExec(input.command, input.args)}`,
		"Restart=always",
		"RestartSec=2",
		"KillMode=mixed",
		"TimeoutStopSec=30",
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
		runRuntimeUserCommand(program.command, args, "", paths.userHome, program.cwd);
		return null;
	} catch (error) {
		return `official ${runtimeSystemdProgramName(program)} service install failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
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
	const managed = new Set(["clawdi-runtime-watch.service", "clawdi-daemon.service"]);
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

function writeSystemdUnits(
	runtimePrograms: RuntimeSystemdUserProgram[],
	mitmProgram: RuntimeMitmSystemdProgram | null,
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	workspaceRoot: string,
	daemonAuthTokenFile: string | null,
	secretValues: Record<string, string> | undefined,
): { systemUnits: string[]; userUnits: string[]; serviceInstallErrors: string[] } {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	const runtimeBridgeToken = hostedRuntimeBridgeToken();
	const bridgeSurfaceSpecs = runtimeBridgeSurfaceSpecsForManifest(manifest);
	const commonEnvironment = {
		HOME: paths.userHome,
		CLAWDI_RUNTIME_MODE: "hosted",
		CLAWDI_RUNTIME_USER: runtimeUser,
		CLAWDI_SERVICE_STATE_DIR: paths.serviceStateRoot,
		CLAWDI_RUN_DIR: paths.runRoot,
		CLAWDI_HOST_POLICY_PATH: paths.hostPolicy,
		[RUNTIME_BRIDGE_TOKEN_ENV]: "",
		[RUNTIME_BRIDGE_LISTEN_HOST_ENV]: process.env[RUNTIME_BRIDGE_LISTEN_HOST_ENV]?.trim() ?? "",
		[RUNTIME_BRIDGE_SURFACES_ENV]: "",
		PATH: runtimeSystemdPath(paths),
	};
	const systemUnits: string[] = [];
	const shouldRunBridge = bridgeSurfaceSpecs.length > 0;
	const shouldRunMitm = mitmProgram !== null && runtimePrograms.length > 0;
	const shouldRunDaemon =
		daemonAuthTokenFile !== null && desiredLiveSyncAgents(manifest).length > 0;
	const userUnits: string[] = [];
	const serviceInstallErrors: string[] = [];

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

	if (shouldRunBridge || shouldRunMitm) {
		userUnits.push(
			writeSystemdUserUnit({
				paths,
				name: "clawdi-runtime-sidecar",
				description: "Clawdi hosted runtime sidecar",
				command: "clawdi",
				args: ["runtime", "sidecar"],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					CLAWDI_AUTH_TOKEN: "",
					[RUNTIME_BRIDGE_TOKEN_ENV]: shouldRunBridge ? runtimeBridgeToken : "",
					[RUNTIME_BRIDGE_SURFACES_ENV]: shouldRunBridge ? JSON.stringify(bridgeSurfaceSpecs) : "",
					CLAWDI_MITM_PROFILE_BUNDLE:
						shouldRunMitm && mitmProgram ? mitmProgram.profileBundlePath : "",
					CLAWDI_MITM_PROXY_URL: shouldRunMitm && mitmProgram ? mitmProgram.proxyUrl : "",
					CLAWDI_MITM_CA_FILE: shouldRunMitm && mitmProgram ? mitmProgram.caFile : "",
					CLAWDI_MITM_SECRET_FILE:
						shouldRunMitm && mitmProgram ? (mitmProgram.secretFilePath ?? "") : "",
					CLAWDI_RUNTIME_REV: runtimeSidecarProgramRevision(manifest, secretValues),
				},
			}),
		);
	}

	for (const program of runtimePrograms) {
		const unitName = systemdUnitFileName(runtimeSystemdProgramName(program));
		const attemptedOfficialServiceInstall = Boolean(
			officialRuntimeServiceInstallArgs(program) && shouldInstallOfficialRuntimeServices(),
		);
		const officialServiceInstallError = installOfficialRuntimeUserService(program, paths);
		if (officialServiceInstallError) serviceInstallErrors.push(officialServiceInstallError);
		if (
			program.runtime === "openclaw" &&
			attemptedOfficialServiceInstall &&
			!officialServiceInstallError
		) {
			try {
				applyOpenClawHostedProjectionAfterOfficialInstall(
					program.command,
					manifest,
					paths.userHome,
					workspaceRoot,
				);
			} catch (error) {
				serviceInstallErrors.push(
					`official ${runtimeSystemdProgramName(program)} hosted gateway projection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		const runtimeEnvironment = {
			...commonEnvironment,
			...program.env,
			CLAWDI_AUTH_TOKEN: "",
			CLAWDI_RUNTIME_REV: runtimeSystemdProgramRevision(manifest, program, secretValues),
			...(officialRuntimeServiceDescriptorForProgram(program)?.unitEnv?.(unitName) ?? {}),
		};
		if (officialRuntimeServiceInstallArgs(program)) {
			// Without a base unit the drop-in cannot converge to a startable
			// service; skip it so systemd apply does not enable a broken unit.
			// The next convergence retries the official install.
			if (officialServiceInstallError && !existsSync(join(paths.systemdUserRoot, unitName))) {
				continue;
			}
			userUnits.push(
				writeSystemdUserDropIn({
					paths,
					name: runtimeSystemdProgramName(program),
					command: program.command,
					args: program.args,
					cwd: program.cwd,
					env: runtimeEnvironment,
				}),
			);
		} else {
			userUnits.push(
				writeSystemdUserUnit({
					paths,
					name: runtimeSystemdProgramName(program),
					description: `Clawdi hosted ${program.runtime}${program.service ? ` ${program.service}` : ""}`,
					command: program.command,
					args: program.args,
					cwd: program.cwd,
					env: runtimeEnvironment,
				}),
			);
		}
	}

	const failedOfficialUninstallUnits: string[] = [];
	for (const unitName of staleOfficialRuntimeUserServices(paths, userUnits)) {
		const officialServiceUninstallError = uninstallOfficialRuntimeUserService({
			unitName,
			paths,
			workspaceRoot,
		});
		if (officialServiceUninstallError) {
			serviceInstallErrors.push(officialServiceUninstallError);
			failedOfficialUninstallUnits.push(join(paths.systemdUserRoot, unitName));
		}
	}
	const protectedUserUnits = [...userUnits, ...failedOfficialUninstallUnits];
	removeStaleSystemdSystemUnits(paths, systemUnits);
	removeStaleSystemdUserUnits(paths, protectedUserUnits);
	removeStaleSystemdEnvironmentFiles(paths, [...systemUnits, ...protectedUserUnits]);
	return { systemUnits, userUnits, serviceInstallErrors };
}

function runtimeWorkspaceRoot(manifest: RuntimeManifest, paths: RuntimePaths): string {
	return manifest.workspaceRoot ?? paths.workspaceRoot;
}

export function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: { cacheLastGood?: boolean } = {},
): RuntimeConvergenceResult {
	const { manifest } = load;
	const workspaceRoot = runtimeWorkspaceRoot(manifest, paths);
	const enabledRuntimes = Object.entries(manifest.runtimes)
		.filter(([, runtime]) => runtime.enabled)
		.map(([name]) => name)
		.sort();
	const generatedAt = new Date().toISOString();
	const instanceRoot = join(paths.instanceRoot, manifest.instanceId);
	const semRoot = join(instanceRoot, "sem");
	const instanceSemaphores: string[] = [];
	const installInventory: string[] = [];
	const projections: string[] = [];
	const runConfigs: string[] = [];
	const runtimeSystemdUserPrograms: RuntimeSystemdUserProgram[] = [];
	const installErrors: string[] = [];
	const writtenRuntimeSecretIds = new Set<string>();

	mkdirSync(workspaceRoot, { recursive: true });
	makeRuntimeUserOwned(paths.userHome);
	makeRuntimeUserPrivateDir(paths.clawdiHome);
	makeRuntimeUserOwned(workspaceRoot);
	mkdirSync(paths.installInventory, { recursive: true });
	mkdirSync(paths.projectionRoot, { recursive: true });
	mkdirSync(semRoot, { recursive: true });
	mkdirSync(paths.managedSecretRoot, { recursive: true });
	makeManagedSecretRoot(paths.managedSecretRoot);

	let manifestLastGood: string | null = null;
	writeJsonFile(paths.managedConfig, {
		schemaVersion: "clawdi.hostedManagedConfig.v1",
		generatedAt,
		deploymentId: manifest.deploymentId,
		environmentId: manifest.environmentId,
		instanceId: manifest.instanceId,
		generation: manifest.generation,
		controlPlane: manifest.controlPlane,
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
		controlPlane: manifest.controlPlane,
		workspaceRoot,
	});
	writeJsonFile(paths.sensitiveInstanceData, {
		schemaVersion: "clawdi.runtimeSensitiveInstanceData.v1",
		generatedAt,
		tokenSource: process.env.CLAWDI_AUTH_TOKEN ? "CLAWDI_AUTH_TOKEN" : load.source,
		token: "<redacted>",
	});

	const mitmProfileBundle = buildMitmProfileBundle({
		generatedAt,
		generation: manifest.generation,
		instanceId: manifest.instanceId,
		profiles: manifest.mitmProfiles,
	});
	const mitmProfileBundlePath = hasEnabledMitmProfiles(mitmProfileBundle)
		? writeMitmProfileBundle(mitmProfileBundle, paths)
		: clearMitmProfileBundle(paths);
	const daemonAuthTokenFile = writeDaemonAuthToken(paths);
	writeSecretValues(load.secretValues, paths);
	try {
		materializeHostedChannelCredentials(manifest, load.secretValues);
	} catch (error) {
		installErrors.push(
			`runtime channel credential materialization failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const mitmSecretFile = writeMitmSecretFile(manifest, load.secretValues, paths);
	const mitmSystemdProgram = runtimeMitmSystemdProgram(
		manifest,
		paths,
		mitmProfileBundlePath,
		mitmSecretFile,
	);
	writeProviderHealthStatus(manifest, load.secretValues, paths);
	const liveSyncEnvironments = writeLiveSyncEnvironmentFiles(manifest, paths);
	const writtenRunConfigIds = new Set<string>();

	for (const [name, runtime] of Object.entries(manifest.runtimes).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const observation = observeRuntimeInstall(name, runtime);
		if (observation.error) installErrors.push(observation.error);

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
			applyHostedAiProviderProjection(name, observation, manifest, workspaceRoot);
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
		const runtimeName = runtimeNameSchema.parse(name);
		const secretEnv = runtime.enabled
			? mergeRuntimeSecretEnv(name, runtime, hostedProviderSecretEnv(manifest, name))
			: {};
		const runtimeProviderSecretFile = writeRuntimeProviderSecretFile(
			name,
			load.secretValues,
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
			mitmProfileBundlePath,
			settings: runtime.run,
			secretFilePath: runtimeProviderSecretFile,
			secretEnv,
		});
		const runConfigPath = writeRuntimeRunConfig(runConfig, paths);
		runConfigs.push(runConfigPath);
		writtenRunConfigIds.add(runtimeRunConfigId(runtimeName));
		if (runtime.enabled && shouldRunRuntime(name, manifest)) {
			const program = buildRuntimeSystemdUserProgram({
				config: runConfig,
				paths,
				secretValues: load.secretValues,
				mitm: mitmSystemdProgram,
			});
			if (program) {
				runtimeSystemdUserPrograms.push(program);
			}
		}
		for (const [serviceName, serviceSettings] of Object.entries(runtime.services ?? {})) {
			const service = runtimeServiceNameSchema.parse(serviceName);
			const serviceSecretEnv = runtime.enabled
				? mergeRuntimeServiceSecretEnv(name, service, serviceSettings, secretEnv)
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
				settings: serviceSettings,
				secretFilePath: null,
				secretEnv: serviceSecretEnv,
			});
			const serviceRunConfigPath = writeRuntimeRunConfig(serviceRunConfig, paths);
			runConfigs.push(serviceRunConfigPath);
			writtenRunConfigIds.add(runtimeRunConfigId(runtimeName, service));
			const program = buildRuntimeSystemdUserProgram({
				config: serviceRunConfig,
				paths,
				secretValues: load.secretValues,
				mitm: mitmSystemdProgram,
			});
			if (program) {
				runtimeSystemdUserPrograms.push(program);
			}
		}

		const semaphorePath = join(semRoot, `${name}.enabled`);
		if (runtime.enabled) {
			writePrivateFileAtomic(semaphorePath, `${generatedAt}\n`);
			instanceSemaphores.push(semaphorePath);
		}
	}

	const mcpProjection = join(paths.projectionRoot, "clawdi-mcp.json");
	writeJsonFile(mcpProjection, projectionPayload("clawdi-mcp", manifest));
	projections.push(mcpProjection);
	const systemdUnits = writeSystemdUnits(
		runtimeSystemdUserPrograms,
		mitmSystemdProgram,
		manifest,
		paths,
		workspaceRoot,
		daemonAuthTokenFile,
		load.secretValues,
	);
	installErrors.push(...systemdUnits.serviceInstallErrors);

	const bootFinished = join(instanceRoot, "boot-finished");
	writePrivateFileAtomic(bootFinished, `${generatedAt}\n`);
	removeStaleRuntimeRunConfigs(writtenRunConfigIds, paths);
	removeStaleRuntimeSecretFiles(writtenRuntimeSecretIds, paths);
	if (installErrors.length === 0 && opts.cacheLastGood !== false) {
		manifestLastGood = writeLastGoodManifest(manifest, paths, load.secretValues);
	}

	return {
		manifest,
		source: load.source,
		sourcePath: load.sourcePath,
		offline: load.offline,
		mode: load.offline ? "degraded-offline" : "normal",
		enabledRuntimes,
		installErrors,
		outputs: {
			processManager: "systemd",
			workspaceRoot,
			managedConfig: paths.managedConfig,
			syncState: paths.syncState,
			instanceData: paths.instanceData,
			sensitiveInstanceData: paths.sensitiveInstanceData,
			manifestLastGood,
			installInventory,
			projections,
			runConfigs,
			systemdSystemUnitRoot: paths.systemdSystemRoot,
			systemdSystemUnits: systemdUnits.systemUnits,
			systemdUserUnitRoot: paths.systemdUserRoot,
			systemdUserUnits: systemdUnits.userUnits,
			mitmProfileBundle: mitmProfileBundlePath,
			mitmSecretFile,
			liveSyncEnvironments,
			daemonAuthTokenFile,
			instanceSemaphores,
			bootFinished,
		},
	};
}
