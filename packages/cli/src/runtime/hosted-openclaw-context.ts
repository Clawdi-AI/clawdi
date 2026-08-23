import { isAbsolute, join, resolve } from "node:path";
import {
	CLAWDI_MANAGED_PROVIDER_ID,
	isClawdiManagedV2ProviderId,
	MANAGED_AI_PROVIDER_RUNTIME_ENV,
} from "@clawdi/shared";
import {
	type OpenClawAgentWorkspace,
	parseOpenClawAgentWorkspaces,
} from "../adapters/openclaw-workspace";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../lib/codex-oauth-native-store";
import { agentTargetProjectionInput, hostedAiProviderCatalog } from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import {
	executableExists,
	runtimeUserDirectoryOwnership,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
import { parseSystemctlShow, systemctlPath } from "./systemd";

export const CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID = "clawdi-managed-provider";
const OPENCLAW_AGENT_ID = "main";
const OPENCLAW_CONFIG_PROBE_TIMEOUT_MS = 15_000;
const OPENCLAW_CONFIG_REPAIR_TIMEOUT_MS = 120_000;
const OPENCLAW_GATEWAY_UNIT = "openclaw-gateway.service";
const OPENCLAW_GATEWAY_TRANSITION_RETRIES = 2;
const OPENCLAW_GATEWAY_TRANSITION_RETRY_DELAY_MS = 3_000;

export type OpenClawHostedContext = ReturnType<typeof createOpenClawHostedContext>;

function installedCommandPath(home: string): string | null {
	return withRuntimeUserFileAccess(() => {
		for (const candidate of [
			join(home, ".local", "bin", "openclaw"),
			join(home, ".openclaw", "bin", "openclaw"),
		]) {
			if (executableExists(candidate)) return candidate;
		}
		return null;
	});
}

function commandPath(home: string): string {
	const command = installedCommandPath(home);
	if (command) return command;
	throw new Error("installed OpenClaw CLI is unavailable");
}

function parseOfficialWorkspaceRoster(stdout: string): string {
	let roster: OpenClawAgentWorkspace[];
	try {
		roster = parseOpenClawAgentWorkspaces(stdout);
	} catch {
		throw new Error("OpenClaw official agent workspace roster is malformed");
	}
	const main = roster.filter((entry) => entry.id === OPENCLAW_AGENT_ID);
	if (main.length !== 1 || !isAbsolute(main[0].workspace)) {
		throw new Error("OpenClaw official agent workspace roster is malformed");
	}
	return resolve(main[0].workspace);
}

function openClawGatewayIsTransitioning(home: string): boolean {
	const result = spawnRuntimeUserCommand(
		systemctlPath(),
		["--user", "show", OPENCLAW_GATEWAY_UNIT, "--property=LoadState", "--property=ActiveState"],
		home,
		home,
		{ timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS, maxBufferBytes: 64 * 1024 },
	);
	if (result.status !== 0) return false;
	const state = parseSystemctlShow(String(result.stdout));
	return (
		state.LoadState === "loaded" &&
		(state.ActiveState === "activating" || state.ActiveState === "deactivating")
	);
}

function waitForOpenClawGatewayTransition(): void {
	Atomics.wait(
		new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
		0,
		0,
		OPENCLAW_GATEWAY_TRANSITION_RETRY_DELAY_MS,
	);
}

export function resolveHostedOpenClawWorkspace(home: string): string {
	const command = commandPath(home);
	let result = spawnRuntimeUserCommand(command, ["agents", "list", "--json"], home, home, {
		timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS,
		maxBufferBytes: 1024 * 1024,
	});
	for (
		let attempt = 0;
		result.status !== 0 &&
		attempt < OPENCLAW_GATEWAY_TRANSITION_RETRIES &&
		openClawGatewayIsTransitioning(home);
		attempt += 1
	) {
		waitForOpenClawGatewayTransition();
		result = spawnRuntimeUserCommand(command, ["agents", "list", "--json"], home, home, {
			timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS,
			maxBufferBytes: 1024 * 1024,
		});
	}
	if (result.status !== 0) {
		throw new Error("OpenClaw official agent workspace roster is unavailable");
	}
	return parseOfficialWorkspaceRoster(String(result.stdout));
}

function invalidConfigValidation(result: ReturnType<typeof spawnRuntimeUserCommand>): boolean {
	if (result.status !== 1 || result.error || result.signal) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(result.stdout));
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const validation = parsed as Record<string, unknown>;
	if (
		validation.valid !== false ||
		typeof validation.path !== "string" ||
		!Array.isArray(validation.issues) ||
		validation.issues.length === 0
	) {
		return false;
	}
	return validation.issues.every((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const issue = value as Record<string, unknown>;
		return typeof issue.path === "string" && typeof issue.message === "string";
	});
}

export function repairHostedOpenClawConfig(home: string): boolean {
	const command = commandPath(home);
	const validation = spawnRuntimeUserCommand(
		command,
		["config", "validate", "--json"],
		home,
		home,
		{ timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS, maxBufferBytes: 1024 * 1024 },
	);
	if (!invalidConfigValidation(validation)) return false;
	const repair = spawnRuntimeUserCommand(
		command,
		["doctor", "--fix", "--non-interactive"],
		home,
		home,
		{ timeoutMs: OPENCLAW_CONFIG_REPAIR_TIMEOUT_MS, maxBufferBytes: 4 * 1024 * 1024 },
	);
	if (repair.status !== 0) throw new Error("OpenClaw official config repair failed");
	return true;
}

function resolveSdkExports(
	home: string,
	location: { commandPath?: string | null; appRoot?: string | null } = {},
) {
	const startPaths = [location.commandPath, location.appRoot];
	const resolve = (path: Parameters<typeof resolveOpenClawSdkExport>[2]) =>
		resolveOpenClawSdkExport(home, startPaths, path);
	const testOverride = (name: "PROVIDER_AUTH" | "PROVIDER_ENV_VARS") => {
		const variable = `CLAWDI_RUNTIME_TEST_OPENCLAW_${name}_SDK`;
		const value = process.env[variable]?.trim();
		if (value && process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1") {
			throw new Error(`${variable} requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1`);
		}
		return value || null;
	};
	return withRuntimeUserFileAccess(() => ({
		configMutation: resolve(OPENCLAW_SDK_EXPORT_PATHS.configMutation),
		deviceBootstrap: resolve(OPENCLAW_SDK_EXPORT_PATHS.deviceBootstrap),
		providerAuth: testOverride("PROVIDER_AUTH") ?? resolve(OPENCLAW_SDK_EXPORT_PATHS.providerAuth),
		providerEnvVars:
			testOverride("PROVIDER_ENV_VARS") ?? resolve(OPENCLAW_SDK_EXPORT_PATHS.providerEnvVars),
	}));
}

export function hostedOpenClawRuntimeUserOwnership(manifest: RuntimeManifest, home: string) {
	const stateRoot = join(home, ".openclaw");
	return manifest.runtimes.openclaw?.enabled === true
		? [
				...runtimeUserDirectoryOwnership(stateRoot, { mode: 0o700 }),
				...runtimeUserDirectoryOwnership(join(stateRoot, "tmp"), { mode: 0o700 }),
			]
		: [];
}

export function createOpenClawHostedContext(manifest: RuntimeManifest, home: string) {
	const stateRoot = join(home, ".openclaw");
	const statePath = (...parts: string[]) => join(stateRoot, ...parts);
	const configPath = statePath("openclaw.json");
	const database = statePath("state", "openclaw.sqlite");
	const sourceDir = statePath("managed-sources", CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID);
	const installDir = statePath("extensions", CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID);
	const sdk = resolveSdkExports(home);
	const ownership = hostedOpenClawRuntimeUserOwnership(manifest, home);
	return {
		home,
		managedApiKeyProjection: hasManagedApiKeyProjection(manifest),
		stateRoot,
		configPath,
		ownership,
		agentDirs: {
			main: statePath("agents", "main", "agent"),
			managed: [] as string[],
		},
		providerPlugin: {
			sourceDir,
			installDir,
			mutationTargets: [
				configPath,
				sourceDir,
				installDir,
				...["", "-wal", "-shm"].map((suffix) => database + suffix),
			],
		},
		sdk,
		requireSdkExport(name: keyof typeof sdk): string {
			const path = sdk[name];
			if (path) return path;
			const exportName = OPENCLAW_SDK_EXPORT_PATHS[name];
			throw new Error(`installed OpenClaw ${exportName} SDK export is unavailable`);
		},
		refreshSdkExports(location: { commandPath?: string | null; appRoot?: string | null }): void {
			Object.assign(sdk, resolveSdkExports(home, location));
		},
	};
}

function hasManagedApiKeyProjection(manifest: RuntimeManifest): boolean {
	const runtime = manifest.runtimes.openclaw;
	const sourceProviderId = runtime?.provider_ids?.[0];
	if (!sourceProviderId || !isClawdiManagedV2ProviderId(sourceProviderId)) return false;
	const sourceProvider = recordValue(manifest.projection?.providers?.[sourceProviderId]);
	const projectionInput = agentTargetProjectionInput(hostedAiProviderCatalog(manifest, "openclaw"));
	const provider = projectionInput?.catalog.providers.find(
		(entry) => entry.id === CLAWDI_MANAGED_PROVIDER_ID,
	);
	return (
		runtime?.enabled === true &&
		runtime.providerMode === "configured" &&
		sourceProvider?.managed_by === "clawdi" &&
		typeof sourceProvider.apiKeySecretRef === "string" &&
		provider?.managed_by === "clawdi" &&
		provider.runtime_env_name === MANAGED_AI_PROVIDER_RUNTIME_ENV &&
		provider.auth.type === "api_key" &&
		provider.auth.source === "managed"
	);
}

function recordValue(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}
