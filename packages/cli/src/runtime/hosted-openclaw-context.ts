import { existsSync, readFileSync } from "node:fs";
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
import { runtimeFileCurrentRevision } from "./manifest-install";
import { runtimeImpactRevision } from "./runtime-impact-revision";
import { executableExists, spawnRuntimeUserCommand } from "./runtime-user-command";
import { parseSystemctlShow, systemctlPath } from "./systemd";

const OPENCLAW_AGENT_ID = "main";
const OPENCLAW_CONFIG_PROBE_TIMEOUT_MS = 15_000;
const OPENCLAW_CONFIG_REPAIR_TIMEOUT_MS = 120_000;
const OPENCLAW_STARTUP_LOG_PROBE_TIMEOUT_MS = 10_000;
const OPENCLAW_GATEWAY_UNIT = "openclaw-gateway.service";
const OPENCLAW_GATEWAY_TRANSITION_RETRIES = 2;
const OPENCLAW_GATEWAY_TRANSITION_RETRY_DELAY_MS = 3_000;
const openClawWorkspaces = new Map<string, { revision: string; workspace: string }>();
const OPENCLAW_STARTUP_MIGRATION_MARKER = "OpenClaw startup migrations did not complete cleanly";
const OPENCLAW_DEVICE_IDENTITY_CONFLICT =
	"canonical SQLite device identity differs from the legacy identity";

const OPENCLAW_ARCHIVE_LEGACY_IDENTITY_HELPER = `
import { pathToFileURL } from "node:url";
const sdk = await import(pathToFileURL(process.argv[1]).href);
if (typeof sdk.archiveLegacyStateSource !== "function") {
  throw new Error("required public migration archive export is missing");
}
const changes = [];
const warnings = [];
await sdk.archiveLegacyStateSource({
  filePath: process.argv[2],
  label: "device identity",
  changes,
  warnings,
});
if (warnings.length !== 0 || changes.length !== 1) {
  throw new Error(warnings[0] ?? "legacy device identity was not archived");
}
process.stdout.write(JSON.stringify({ archived: true }));
`;

class OpenClawWorkspaceRosterError extends Error {
	constructor(readonly doctorRepairRequired: boolean) {
		super("OpenClaw official agent workspace roster is unavailable");
		this.name = "OpenClawWorkspaceRosterError";
	}
}

function runtimeCommandOutput(result: ReturnType<typeof spawnRuntimeUserCommand>): string {
	return [result.stderr, result.stdout]
		.filter((value): value is string => typeof value === "string")
		.join("\n");
}

function openClawDoctorRepairRequired(result: ReturnType<typeof spawnRuntimeUserCommand>): boolean {
	const output = runtimeCommandOutput(result);
	return (
		output.includes(OPENCLAW_STARTUP_MIGRATION_MARKER) &&
		output.includes('Run "openclaw doctor --fix"')
	);
}

function openClawStartupMigrationWarning(
	result: ReturnType<typeof spawnRuntimeUserCommand>,
): boolean {
	return runtimeCommandOutput(result).includes(OPENCLAW_STARTUP_MIGRATION_MARKER);
}

function openClawDeviceIdentityConflict(
	result: ReturnType<typeof spawnRuntimeUserCommand>,
): boolean {
	return (
		!result.error &&
		!result.signal &&
		runtimeCommandOutput(result).includes(OPENCLAW_DEVICE_IDENTITY_CONFLICT)
	);
}

export type OpenClawHostedContext = ReturnType<typeof createOpenClawHostedContext>;

function installedCommandPath(home: string): string | null {
	for (const candidate of [
		join(home, ".local", "bin", "openclaw"),
		join(home, ".openclaw", "bin", "openclaw"),
	]) {
		if (executableExists(candidate)) return candidate;
	}
	return null;
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

export function openClawRosterConfigRevision(home: string): string {
	try {
		const config = JSON.parse(
			readFileSync(join(home, ".openclaw", "openclaw.json"), "utf8"),
		) as unknown;
		const root =
			config && typeof config === "object" && !Array.isArray(config)
				? (config as Record<string, unknown>)
				: {};
		const agents =
			root.agents && typeof root.agents === "object" && !Array.isArray(root.agents)
				? (root.agents as Record<string, unknown>)
				: {};
		const defaults =
			agents.defaults && typeof agents.defaults === "object" && !Array.isArray(agents.defaults)
				? (agents.defaults as Record<string, unknown>)
				: {};
		return runtimeImpactRevision({
			defaultWorkspace: defaults.workspace ?? null,
			entries: agents.entries ?? null,
			list: agents.list ?? null,
		});
	} catch {
		return "unavailable";
	}
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
	const revision = [runtimeFileCurrentRevision(command), openClawRosterConfigRevision(home)].join(
		"\0",
	);
	const cached = openClawWorkspaces.get(home);
	if (cached?.revision === revision) return cached.workspace;
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
	if (openClawDoctorRepairRequired(result)) throw new OpenClawWorkspaceRosterError(true);
	if (result.status !== 0) throw new OpenClawWorkspaceRosterError(false);
	const workspace = parseOfficialWorkspaceRoster(String(result.stdout));
	openClawWorkspaces.set(home, { revision, workspace });
	return workspace;
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
	runHostedOpenClawDoctor(home, command);
	return true;
}

function runHostedOpenClawDoctorCommand(home: string, command = commandPath(home)) {
	return spawnRuntimeUserCommand(command, ["doctor", "--fix", "--non-interactive"], home, home, {
		timeoutMs: OPENCLAW_CONFIG_REPAIR_TIMEOUT_MS,
		maxBufferBytes: 4 * 1024 * 1024,
	});
}

function runHostedOpenClawDoctor(home: string, command = commandPath(home)): void {
	const repair = runHostedOpenClawDoctorCommand(home, command);
	if (repair.status !== 0) throw new Error("OpenClaw official repair failed");
}

function openClawStartupMigrationFailed(home: string): boolean {
	const legacyIdentity = join(home, ".openclaw", "identity", "device.json");
	if (!existsSync(legacyIdentity)) return false;
	const journalctl = process.env.CLAWDI_JOURNALCTL_PATH?.trim() || "journalctl";
	const result = spawnRuntimeUserCommand(
		journalctl,
		[
			`--user-unit=${OPENCLAW_GATEWAY_UNIT}`,
			"--boot=0",
			"--no-pager",
			"--quiet",
			"--output=cat",
			"--lines=500",
		],
		home,
		home,
		{ timeoutMs: OPENCLAW_STARTUP_LOG_PROBE_TIMEOUT_MS, maxBufferBytes: 1024 * 1024 },
	);
	return result.status === 0 && openClawStartupMigrationWarning(result);
}

function archiveHostedLegacyOpenClawIdentity(home: string, command: string): void {
	const sdkPath = resolveOpenClawSdkExport(
		home,
		[command],
		OPENCLAW_SDK_EXPORT_PATHS.doctorMigrations,
	);
	if (!sdkPath) {
		throw new Error("installed OpenClaw public migration archive SDK is unavailable");
	}
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_ARCHIVE_LEGACY_IDENTITY_HELPER,
			sdkPath,
			join(home, ".openclaw", "identity", "device.json"),
		],
		home,
		home,
		{ timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS, maxBufferBytes: 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error("OpenClaw legacy device identity archive failed");
	}
}

export function repairHostedOpenClawStartupMigrations(home: string): boolean {
	if (!openClawStartupMigrationFailed(home)) return false;
	const command = commandPath(home);
	const repair = runHostedOpenClawDoctorCommand(home, command);
	if (!openClawDeviceIdentityConflict(repair)) {
		if (repair.status !== 0) throw new Error("OpenClaw official repair failed");
		return true;
	}
	archiveHostedLegacyOpenClawIdentity(home, command);
	const verified = runHostedOpenClawDoctorCommand(home, command);
	if (verified.status !== 0 || openClawDeviceIdentityConflict(verified)) {
		throw new Error("OpenClaw legacy device identity retirement did not clear the conflict");
	}
	return true;
}

export function repairHostedOpenClawWorkspace(home: string, error: unknown): boolean {
	if (error instanceof OpenClawWorkspaceRosterError && error.doctorRepairRequired) {
		runHostedOpenClawDoctor(home);
		return true;
	}
	return repairHostedOpenClawConfig(home);
}

function resolveSdkExports(
	home: string,
	location: { commandPath?: string | null; appRoot?: string | null } = {},
) {
	const startPaths = [location.commandPath, location.appRoot];
	const resolve = (path: Parameters<typeof resolveOpenClawSdkExport>[2]) =>
		resolveOpenClawSdkExport(home, startPaths, path);
	const testOverride = () => {
		const name = "PROVIDER_AUTH";
		const variable = `CLAWDI_RUNTIME_TEST_OPENCLAW_${name}_SDK`;
		const value = process.env[variable]?.trim();
		if (value && process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1") {
			throw new Error(`${variable} requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1`);
		}
		return value || null;
	};
	return {
		configMutation: resolve(OPENCLAW_SDK_EXPORT_PATHS.configMutation),
		deviceBootstrap: resolve(OPENCLAW_SDK_EXPORT_PATHS.deviceBootstrap),
		providerAuth: testOverride() ?? resolve(OPENCLAW_SDK_EXPORT_PATHS.providerAuth),
	};
}

export function createOpenClawHostedContext(manifest: RuntimeManifest, home: string) {
	const stateRoot = join(home, ".openclaw");
	const statePath = (...parts: string[]) => join(stateRoot, ...parts);
	const configPath = statePath("openclaw.json");
	const sdk = resolveSdkExports(home);
	return {
		home,
		managedApiKeyProjection: hasManagedApiKeyProjection(manifest),
		stateRoot,
		configPath,
		agentDirs: {
			main: statePath("agents", "main", "agent"),
			managed: [] as string[],
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
