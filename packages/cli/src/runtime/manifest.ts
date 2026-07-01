import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	chownSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AiProviderApiMode,
	AiProviderAuth,
	AiProviderCatalog,
	AiProviderType,
} from "@clawdi/shared";
import { isAiProviderType } from "@clawdi/shared";
import { z } from "zod";
import { buildAgentTargetProjection } from "../lib/ai-provider-projection";
import {
	mergeHermesConfig,
	mergeHermesMcpServer,
	removeHermesMcpServer,
} from "../lib/hermes-config-merge";
import { writePrivateFileAtomic } from "../lib/private-file";
import { normalizeSecretRef } from "./hosted-mitm-profiles";
import type { LiveSyncAgent, RuntimeInstall, RuntimeManifest } from "./manifest-contract";

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
	type RuntimeServiceName,
	runtimeCommandShimDir,
	runtimeNameSchema,
	runtimeRunConfigId,
	runtimeServiceNameSchema,
	type SupportedRuntimeName,
	writeRuntimeRunConfig,
} from "./run-config";

export interface RuntimeConvergenceResult {
	manifest: RuntimeManifest;
	source: RuntimeManifestLoad["source"];
	sourcePath: string;
	offline: boolean;
	mode: "normal" | "degraded-offline";
	enabledRuntimes: string[];
	installErrors: string[];
	outputs: {
		workspaceRoot: string;
		managedConfig: string;
		syncState: string;
		instanceData: string;
		sensitiveInstanceData: string;
		manifestLastGood: string | null;
		installInventory: string[];
		projections: string[];
		runConfigs: string[];
		supervisorConfig: string;
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

function writeLastGoodManifest(manifest: RuntimeManifest, paths: RuntimePaths): string | null {
	if (manifest.recovery.cacheManifest === false) {
		rmSync(paths.manifestLastGood, { force: true });
		return null;
	}
	writeJsonFile(paths.manifestLastGood, manifest);
	return paths.manifestLastGood;
}

function writeSecretValues(
	secretValues: Record<string, string> | undefined,
	paths: RuntimePaths,
): string | null {
	const path = paths.managedSecretFile;
	const legacyPath = join(paths.runRoot, "mitm", "secrets.json");
	if (!secretValues || Object.keys(secretValues).length === 0) {
		rmSync(path, { force: true });
		rmSync(legacyPath, { force: true });
		return null;
	}
	rmSync(legacyPath, { force: true });
	writePrivateFileAtomic(path, `${JSON.stringify(secretValues, null, 2)}\n`, {
		mode: 0o600,
		dirMode: 0o700,
	});
	makeRootOwned(dirname(path));
	makeRuntimeSecretReadable(path);
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort for non-POSIX local development environments.
	}
	return path;
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
	if (!stringValue(provider.model)) {
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
	return reasons;
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

function makeRuntimeSecretReadable(path: string): void {
	const dir = dirname(path);
	makeRootOwned(dir);
	try {
		chmodSync(dir, 0o711);
	} catch {
		// Best effort for non-POSIX local development environments.
	}
	makeRuntimeUserOwned(path);
}

function makeRuntimeUserPrivateDir(path: string): void {
	mkdirSync(path, { recursive: true });
	makeRuntimeUserOwned(path);
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
	if (name === "openclaw") return join(home, ".openclaw", "bin", "openclaw");
	if (name === "hermes") return join(home, ".local", "bin", "hermes");
	return null;
}

function runtimeAppRoot(name: string, home: string): string | null {
	if (name === "openclaw") return join(home, ".openclaw");
	if (name === "hermes") return join(home, ".hermes", "hermes-agent");
	return null;
}

const SUPPORTED_RUNTIME_NAMES = [
	"hermes",
	"openclaw",
] as const satisfies readonly SupportedRuntimeName[];

const runtimeCommandShimIndexSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeCommandShims.v1"),
		commands: z.array(runtimeNameSchema).default([]),
	})
	.strict();

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
		if (runtime.run?.command?.trim()) {
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
				? "openclaw config patch --stdin --replace-path models.providers"
				: name === "hermes"
					? "official Hermes user config"
					: "clawdi mcp",
		projection: projection ?? null,
	};
}

function hostedAiProviderCatalog(
	manifest: RuntimeManifest,
	runtimeName?: string,
): AiProviderCatalog | null {
	const providers = manifest.projection?.providers;
	if (!providers || Object.keys(providers).length === 0) return null;
	const rawEntries = hostedProviderEntries(providers, runtimeName);
	const entries = rawEntries
		.map(([id, raw]) => {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
			const input = raw as Record<string, unknown>;
			const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : undefined;
			const model = typeof input.model === "string" ? input.model : undefined;
			const apiMode = hostedProviderApiMode(input);
			const apiKeySecretRef =
				typeof input.apiKeySecretRef === "string" ? input.apiKeySecretRef : undefined;
			const runtimeEnvName = hostedProviderRuntimeEnvName(id, input);
			if (!baseUrl || !model) return null;
			const auth = hostedProviderAuth(input, Boolean(apiKeySecretRef));
			return {
				id,
				type: hostedProviderType(input),
				base_url: baseUrl,
				default_model: model,
				api_mode: apiMode,
				auth,
				runtime_env_name: apiKeySecretRef || auth.type !== "none" ? runtimeEnvName : undefined,
				models: [{ id: model, api_mode: apiMode }],
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
	if (entries.length === 0) return null;
	return {
		schema_version: 1,
		providers: entries,
		defaults: { chat_provider_id: entries[0]?.id },
	};
}

function hostedProviderEntries(
	providers: Record<string, unknown>,
	runtimeName?: string,
): Array<[string, unknown]> {
	if (!runtimeName) {
		return Object.entries(providers).sort(([left], [right]) => left.localeCompare(right));
	}
	if (Object.hasOwn(providers, runtimeName)) {
		return [[runtimeName, providers[runtimeName]]];
	}
	if (Object.hasOwn(providers, "default")) {
		return [["default", providers.default]];
	}
	return [];
}

function hostedProviderApiMode(input: Record<string, unknown>): AiProviderApiMode {
	const raw = typeof input.apiMode === "string" ? input.apiMode : input.api_mode;
	if (raw === "openai_chat" || raw === "openai_responses") {
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
): AiProviderAuth {
	const auth = recordValue(input.auth);
	if (auth) {
		const type = stringValue(auth.type);
		const tool = stringValue(auth.tool);
		const profile = stringValue(auth.profile);
		if (type === "agent_profile" && tool === "codex" && profile) {
			return { type: "agent_profile", tool: "codex", profile };
		}
	}
	if (hasApiKeySecretRef) {
		return { type: "api_key", source: "managed" };
	}
	return { type: "none" };
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
	for (const [providerId, raw] of hostedProviderEntries(providers, runtimeName)) {
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
	const catalog = hostedAiProviderCatalog(manifest, name);
	if (!catalog) return null;
	const home = projectionSystemHome(manifest) ?? process.env.HOME ?? "";
	if (name === "hermes") {
		const projection = buildAgentTargetProjection("hermes", catalog);
		const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
		if (!file) throw new Error("Hermes projection did not include a config merge YAML file.");
		const configPath = join(home, ".hermes", "config.yaml");
		mergeHermesConfig(configPath, file.content);
		makeRuntimeUserOwned(configPath);
		return configPath;
	}
	if (name === "openclaw") {
		const projection = buildAgentTargetProjection("openclaw", catalog);
		const file = projection.files.find((entry) => entry.path.endsWith(".openclaw.json"));
		if (!file) throw new Error("OpenClaw projection did not include a config patch JSON file.");
		runRuntimeUserCommand(
			observation.commandPath,
			["config", "patch", "--stdin", "--replace-path", "models.providers"],
			file.content,
			home,
			workspaceRoot,
		);
		return observation.commandPath;
	}
	return null;
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
	if (name !== "openclaw") return null;
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return null;
	}
	const channels = hostedChannelProjection(manifest);
	if (!channels) return null;

	const home = projectionSystemHome(manifest) ?? process.env.HOME ?? "";
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

function openClawManagedChannelsPatch(channels: Record<string, unknown>): Record<string, unknown> {
	const deleteEntries = openClawManagedChannelDeletes();
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
	};
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
	const script = [
		`export CLAWDI_API_URL=${shellQuote(manifest.controlPlane.apiUrl)}`,
		`export CLAWDI_AUTH_TOKEN="$(cat ${shellQuote(authTokenFile)})"`,
		"exec clawdi mcp",
	].join("; ");
	return {
		command: "/bin/sh",
		args: ["-lc", script],
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
	bluebubbles: ["@openclaw/bluebubbles@2026.5.7"],
};

const OPENCLAW_MANAGED_CHANNELS = ["telegram", "discord", "whatsapp", "bluebubbles"] as const;

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
	makeRootOwned(dirname(path));
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

function runtimeProgramRevision(
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

function runtimeBridgeProgramRevision(manifest: RuntimeManifest): string {
	return revisionHash({
		clawdiCli: manifest.clawdiCli ?? null,
		bridgeSurfaces: runtimeBridgeSurfaceSpecsForManifest(manifest),
		runtimeBridge: "hosted-runtime-bridge-v1",
	});
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeSupervisorConfig(
	enabledRuntimes: string[],
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	workspaceRoot: string,
	daemonAuthTokenFile: string | null,
	secretValues: Record<string, string> | undefined,
): string {
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
		PATH: supervisorPath(paths),
	};
	const watcherEnvironment = supervisorEnvironment({
		...commonEnvironment,
		CLAWDI_AUTH_TOKEN: "",
		[RUNTIME_BRIDGE_TOKEN_ENV]: runtimeBridgeToken,
	});
	const daemonEnvironment = supervisorEnvironment({
		...commonEnvironment,
		CLAWDI_SERVE_MODE: "container",
		CLAWDI_API_URL: manifest.controlPlane.apiUrl,
		CLAWDI_NO_AUTO_UPDATE: "1",
		CLAWDI_NO_UPDATE_CHECK: "1",
		CLAWDI_RUNTIME_REV: daemonProgramRevision(manifest),
	});
	const supervisedEnabled = enabledRuntimes.filter((runtime) =>
		shouldSuperviseRuntime(runtime, manifest),
	);
	const shouldRunDaemon =
		daemonAuthTokenFile !== null && desiredLiveSyncAgents(manifest).length > 0;
	const shouldRunBridge = bridgeSurfaceSpecs.length > 0;
	const providerSecretEnv = hostedProviderSecretEnv(manifest);
	const runtimeNeedsSystemBoundary =
		hasEnabledMitmProfiles(
			buildMitmProfileBundle({
				generatedAt: new Date(0).toISOString(),
				generation: manifest.generation,
				instanceId: manifest.instanceId,
				profiles: manifest.mitmProfiles,
			}),
		) ||
		(supervisedEnabled.length > 0 && Object.keys(providerSecretEnv).length > 0);
	const lines = [
		"; Generated by clawdi runtime init. Do not edit inside hosted runtime.",
		`; Desired-state generation: ${manifest.generation}`,
		"[supervisord]",
		"nodaemon=true",
		"logfile=/dev/null",
		"logfile_maxbytes=0",
		`pidfile=${paths.runRoot}/supervisord.pid`,
		"childlogdir=/tmp",
		"",
		"[unix_http_server]",
		`file=${paths.runRoot}/supervisor.sock`,
		"chmod=0700",
		"chown=root:root",
		"",
		"[supervisorctl]",
		`serverurl=unix://${paths.runRoot}/supervisor.sock`,
		"",
		"[rpcinterface:supervisor]",
		"supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface",
		"",
	];

	if (supervisedEnabled.length === 0 && !shouldRunDaemon) {
		lines.push("; No enabled agent runtimes in the current manifest.", "");
	}

	if (daemonAuthTokenFile) {
		lines.push(
			"[program:clawdi-runtime-watch]",
			"command=/usr/bin/env clawdi runtime watch",
			`directory=${workspaceRoot}`,
			"autostart=true",
			"autorestart=true",
			"startsecs=2",
			"startretries=5",
			"stopasgroup=true",
			"killasgroup=true",
			"stdout_logfile=/dev/fd/1",
			"stdout_logfile_maxbytes=0",
			"stderr_logfile=/dev/fd/2",
			"stderr_logfile_maxbytes=0",
			`environment=${watcherEnvironment}`,
			"",
		);
	}

	if (shouldRunDaemon && daemonAuthTokenFile) {
		const script = `export CLAWDI_AUTH_TOKEN="$(cat ${shellQuote(
			daemonAuthTokenFile,
		)})"; exec /usr/bin/env clawdi daemon run`;
		lines.push(
			"[program:clawdi-daemon]",
			`command=/bin/sh -lc ${shellQuote(script)}`,
			`directory=${workspaceRoot}`,
			"autostart=true",
			"autorestart=true",
			"startsecs=2",
			"startretries=5",
			"stopasgroup=true",
			"killasgroup=true",
			"stdout_logfile=/dev/fd/1",
			"stdout_logfile_maxbytes=0",
			"stderr_logfile=/dev/fd/2",
			"stderr_logfile_maxbytes=0",
			`environment=${daemonEnvironment}`,
			"",
		);
	}

	if (shouldRunBridge) {
		const runtimeBridgeEnvironment = supervisorEnvironment({
			...commonEnvironment,
			CLAWDI_AUTH_TOKEN: "",
			[RUNTIME_BRIDGE_TOKEN_ENV]: runtimeBridgeToken,
			[RUNTIME_BRIDGE_SURFACES_ENV]: JSON.stringify(bridgeSurfaceSpecs),
			CLAWDI_RUNTIME_REV: runtimeBridgeProgramRevision(manifest),
		});
		lines.push(
			"[program:clawdi-runtime-bridge]",
			"command=/usr/bin/env clawdi runtime bridge",
			`directory=${workspaceRoot}`,
			`user=${runtimeUser}`,
			"autostart=true",
			"autorestart=true",
			"startsecs=2",
			"startretries=5",
			"stopasgroup=true",
			"killasgroup=true",
			"stdout_logfile=/dev/fd/1",
			"stdout_logfile_maxbytes=0",
			"stderr_logfile=/dev/fd/2",
			"stderr_logfile_maxbytes=0",
			`environment=${runtimeBridgeEnvironment}`,
			"",
		);
	}

	for (const runtime of supervisedEnabled) {
		const runtimeEnvironment = supervisorEnvironment({
			...commonEnvironment,
			CLAWDI_AUTH_TOKEN: "",
			CLAWDI_RUNTIME_REV: runtimeProgramRevision(manifest, runtime, secretValues),
		});
		lines.push(
			`[program:clawdi-${runtime}]`,
			`command=/usr/bin/env clawdi run -- ${runtime}`,
			`directory=${workspaceRoot}`,
			...(runtimeNeedsSystemBoundary ? [] : [`user=${runtimeUser}`]),
			"autostart=true",
			"autorestart=true",
			"startsecs=2",
			"startretries=5",
			"stopasgroup=true",
			"killasgroup=true",
			"stdout_logfile=/dev/fd/1",
			"stdout_logfile_maxbytes=0",
			"stderr_logfile=/dev/fd/2",
			"stderr_logfile_maxbytes=0",
			`environment=${runtimeEnvironment}`,
			"",
		);
		for (const service of runtimeServiceNames(manifest, runtime)) {
			const serviceEnvironment = supervisorEnvironment({
				...commonEnvironment,
				CLAWDI_AUTH_TOKEN: "",
				CLAWDI_RUNTIME_REV: runtimeServiceProgramRevision(manifest, runtime, service),
			});
			lines.push(
				`[program:${runtimeServiceProgramName(runtime, service)}]`,
				`command=/usr/bin/env clawdi run --runtime-service ${runtimeRunConfigId(runtimeNameSchema.parse(runtime), service)} -- ${runtime}`,
				`directory=${workspaceRoot}`,
				...(runtimeNeedsSystemBoundary ? [] : [`user=${runtimeUser}`]),
				"autostart=true",
				"autorestart=true",
				"startsecs=2",
				"startretries=5",
				"stopasgroup=true",
				"killasgroup=true",
				"stdout_logfile=/dev/fd/1",
				"stdout_logfile_maxbytes=0",
				"stderr_logfile=/dev/fd/2",
				"stderr_logfile_maxbytes=0",
				`environment=${serviceEnvironment}`,
				"",
			);
		}
	}

	writePrivateFileAtomic(paths.supervisorConfig, `${lines.join("\n")}\n`, { mode: 0o644 });
	return paths.supervisorConfig;
}

function shouldSuperviseRuntime(runtime: string, manifest: RuntimeManifest): boolean {
	const desired = manifest.runtimes[runtime];
	if (!desired?.enabled) return false;
	return isSupportedRuntimeName(runtime) || Boolean(desired.run?.command?.trim());
}

function runtimeServiceNames(manifest: RuntimeManifest, runtime: string): RuntimeServiceName[] {
	const desired = manifest.runtimes[runtime];
	if (!desired?.enabled) return [];
	return Object.keys(desired.services ?? {})
		.map((service) => runtimeServiceNameSchema.parse(service))
		.sort();
}

function runtimeServiceProgramName(runtime: string, service: string): string {
	return `clawdi-${supervisorProgramSegment(runtime)}-${supervisorProgramSegment(service)}`;
}

function supervisorProgramSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function writeRuntimeCommandShims(commands: Iterable<RuntimeName>, paths: RuntimePaths): void {
	const binDir = runtimeCommandShimDir(paths);
	const dispatcherPath = join(binDir, ".clawdi-runtime-command-shim");
	const active = new Set(
		[...commands]
			.filter((command) => command !== "clawdi")
			.filter((command) => runtimeNameSchema.safeParse(command).success)
			.sort(),
	);
	const previous = readRuntimeCommandShimIndex(paths);
	const staleCandidates = new Set<RuntimeName>([
		...previous,
		"codex",
		...SUPPORTED_RUNTIME_NAMES,
	] as RuntimeName[]);
	for (const command of staleCandidates) {
		if (!active.has(command)) rmSync(join(binDir, command), { force: true });
	}
	if (active.size === 0) {
		rmSync(dispatcherPath, { force: true });
		writeRuntimeCommandShimIndex(active, paths);
		return;
	}
	writePrivateFileAtomic(dispatcherPath, runtimeCommandShimScript(paths), {
		mode: 0o755,
		dirMode: 0o755,
	});
	makeRuntimeUserOwned(dispatcherPath);
	for (const command of active) {
		const shimPath = join(binDir, command);
		rmSync(shimPath, { force: true });
		symlinkSync(".clawdi-runtime-command-shim", shimPath);
		makeRuntimeUserOwned(shimPath);
	}
	writeRuntimeCommandShimIndex(active, paths);
}

function runtimeCommandShimScript(paths: RuntimePaths): string {
	return [
		"#!/usr/bin/env sh",
		"set -eu",
		"command_name=$" + "{0##*/}",
		'shim_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
		"old_ifs=$" + "{IFS-}",
		"IFS=:",
		"clean_path=",
		"for dir in $" + "{PATH-}; do",
		'  [ "$dir" = "$shim_dir" ] && continue',
		'  if [ -z "$clean_path" ]; then clean_path=$dir; else clean_path=$clean_path:$dir; fi',
		"done",
		"IFS=$old_ifs",
		"export PATH=$clean_path",
		`exec ${shellQuote(paths.cliManagedBin)} run -- "$command_name" "$@"`,
		"",
	].join("\n");
}

function runtimeCommandShimIndexPath(paths: RuntimePaths): string {
	return join(paths.serviceStateRoot, "config", "runtime-command-shims.json");
}

function readRuntimeCommandShimIndex(paths: RuntimePaths): RuntimeName[] {
	const path = runtimeCommandShimIndexPath(paths);
	if (!existsSync(path)) return [];
	try {
		const parsed = runtimeCommandShimIndexSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
		return parsed.commands;
	} catch {
		return [];
	}
}

function writeRuntimeCommandShimIndex(commands: Set<RuntimeName>, paths: RuntimePaths): void {
	writePrivateFileAtomic(
		runtimeCommandShimIndexPath(paths),
		`${JSON.stringify(
			{
				schemaVersion: "clawdi.runtimeCommandShims.v1",
				commands: [...commands].sort(),
			},
			null,
			2,
		)}\n`,
		{ mode: 0o644, dirMode: 0o755 },
	);
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

function supervisorPath(paths: RuntimePaths): string {
	return [
		join(paths.serviceStateRoot, "bin"),
		join(paths.userHome, ".local", "bin"),
		join(paths.userHome, ".openclaw", "bin"),
		process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	].join(":");
}

function supervisorEnvironment(values: Record<string, string>): string {
	return Object.entries(values)
		.map(([key, value]) => `${key}=${supervisorQuoteValue(value)}`)
		.join(",");
}

function supervisorQuoteValue(value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new Error("supervisor environment values must be single-line strings");
	}
	const escaped = value.replace(/%/g, "%%");
	if (!escaped.includes('"')) {
		return `"${escaped.replace(/\\/g, "\\\\")}"`;
	}
	if (!escaped.includes("'")) {
		return `'${escaped}'`;
	}
	throw new Error("supervisor environment values must not contain both quote types");
}

function runtimeWorkspaceRoot(manifest: RuntimeManifest, paths: RuntimePaths): string {
	return manifest.workspaceRoot ?? paths.workspaceRoot;
}

export function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
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
	const commandShims = new Set<RuntimeName>();
	const installErrors: string[] = [];

	mkdirSync(workspaceRoot, { recursive: true });
	makeRuntimeUserOwned(paths.userHome);
	makeRuntimeUserPrivateDir(paths.clawdiHome);
	makeRuntimeUserOwned(workspaceRoot);
	mkdirSync(paths.installInventory, { recursive: true });
	mkdirSync(paths.projectionRoot, { recursive: true });
	mkdirSync(semRoot, { recursive: true });

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
	const mitmSecretFile = writeSecretValues(load.secretValues, paths);
	writeProviderHealthStatus(manifest, load.secretValues, paths);
	const liveSyncEnvironments = writeLiveSyncEnvironmentFiles(manifest, paths);
	const supervisorConfig = writeSupervisorConfig(
		enabledRuntimes,
		manifest,
		paths,
		workspaceRoot,
		daemonAuthTokenFile,
		load.secretValues,
	);
	const writtenRunConfigIds = new Set<string>();
	for (const agent of desiredLiveSyncAgents(manifest)) {
		const parsed = runtimeNameSchema.safeParse(agent.agentType);
		if (parsed.success) commandShims.add(parsed.data);
	}

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
		const runConfigPath = writeRuntimeRunConfig(
			buildRuntimeRunConfig({
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
				secretFilePath: mitmSecretFile,
				secretEnv: hostedProviderSecretEnv(manifest, name),
			}),
			paths,
		);
		runConfigs.push(runConfigPath);
		writtenRunConfigIds.add(runtimeRunConfigId(runtimeName));
		commandShims.add(runtimeName);
		for (const [serviceName, serviceSettings] of Object.entries(runtime.services ?? {})) {
			const service = runtimeServiceNameSchema.parse(serviceName);
			const serviceRunConfigPath = writeRuntimeRunConfig(
				buildRuntimeRunConfig({
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
					secretEnv: {},
				}),
				paths,
			);
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
	writeJsonFile(mcpProjection, projectionPayload("clawdi-mcp", manifest));
	projections.push(mcpProjection);
	writeRuntimeCommandShims(commandShims, paths);

	const bootFinished = join(instanceRoot, "boot-finished");
	writePrivateFileAtomic(bootFinished, `${generatedAt}\n`);
	removeStaleRuntimeRunConfigs(writtenRunConfigIds, paths);
	if (installErrors.length === 0) {
		manifestLastGood = writeLastGoodManifest(manifest, paths);
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
			workspaceRoot,
			managedConfig: paths.managedConfig,
			syncState: paths.syncState,
			instanceData: paths.instanceData,
			sensitiveInstanceData: paths.sensitiveInstanceData,
			manifestLastGood,
			installInventory,
			projections,
			runConfigs,
			supervisorConfig,
			mitmProfileBundle: mitmProfileBundlePath,
			mitmSecretFile,
			liveSyncEnvironments,
			daemonAuthTokenFile,
			instanceSemaphores,
			bootFinished,
		},
	};
}
