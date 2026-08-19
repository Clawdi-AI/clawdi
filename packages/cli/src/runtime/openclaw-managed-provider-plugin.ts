import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MANAGED_AI_PROVIDER_RUNTIME_ENV } from "@clawdi/shared";
import { resolveOpenClawProviderEnvVarsSdkExport } from "../lib/codex-oauth-native-store";
import { openClawPluginInspectSchema } from "./openclaw-plugin-observation";
import { spawnRuntimeUserCommand, withRuntimeUserFileAccess } from "./runtime-user-command";

export const CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID = "clawdi-managed-provider";
const PLUGIN_VERSION = "1.0.0";
const COMMAND_TIMEOUT_MS = 120_000;
const managedOpenClawPluginInspectSchema = openClawPluginInspectSchema.extend({
	install: openClawPluginInspectSchema.shape.install.optional(),
});

const pluginFiles = new Map<string, string>([
	[
		"index.js",
		`${[
			"export default {",
			`  id: ${JSON.stringify(CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID)},`,
			'  name: "Clawdi Managed Provider Metadata",',
			"  register() {},",
			"};",
			"",
		].join("\n")}`,
	],
	[
		"openclaw.plugin.json",
		`${JSON.stringify(
			{
				id: CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID,
				enabledByDefault: true,
				activation: { onStartup: false },
				setup: {
					providers: [
						{
							id: "clawdi",
							authMethods: ["api-key"],
							envVars: [MANAGED_AI_PROVIDER_RUNTIME_ENV],
						},
					],
					requiresRuntime: false,
				},
				configSchema: { type: "object", additionalProperties: false, properties: {} },
			},
			null,
			2,
		)}\n`,
	],
	[
		"package.json",
		`${JSON.stringify(
			{
				name: "@clawdi/openclaw-managed-provider",
				version: PLUGIN_VERSION,
				private: true,
				type: "module",
				openclaw: { extensions: ["./index.js"] },
			},
			null,
			2,
		)}\n`,
	],
]);

function resolveOpenClawPath(value: string | undefined, fallback: string, home: string): string {
	const trimmed = value?.trim();
	if (!trimmed) return fallback;
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
	return resolve(trimmed);
}

export function managedOpenClawStateDir(home: string): string {
	return resolveOpenClawPath(process.env.OPENCLAW_STATE_DIR, join(home, ".openclaw"), home);
}

export function managedOpenClawConfigPath(home: string): string {
	return resolveOpenClawPath(
		process.env.OPENCLAW_CONFIG_PATH,
		join(managedOpenClawStateDir(home), "openclaw.json"),
		home,
	);
}

export function managedOpenClawProviderPluginSourceDir(home: string): string {
	return join(
		managedOpenClawStateDir(home),
		"managed-sources",
		CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID,
	);
}

export function managedOpenClawProviderPluginInstallDir(home: string): string {
	return join(
		managedOpenClawStateDir(home),
		"extensions",
		CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID,
	);
}

export function managedOpenClawProviderPluginMutationTargets(home: string): string[] {
	const database = join(managedOpenClawStateDir(home), "state", "openclaw.sqlite");
	return [
		managedOpenClawProviderPluginSourceDir(home),
		managedOpenClawProviderPluginInstallDir(home),
		database,
		`${database}-wal`,
		`${database}-shm`,
	];
}

function sourceIsCurrent(sourceDir: string): boolean {
	try {
		const stat = lstatSync(sourceDir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		const entries = readdirSync(sourceDir).sort();
		if (entries.length !== pluginFiles.size) return false;
		return entries.every((entry) => {
			const expected = pluginFiles.get(entry);
			if (expected === undefined) return false;
			const path = join(sourceDir, entry);
			const file = lstatSync(path);
			return file.isFile() && !file.isSymbolicLink() && readFileSync(path, "utf8") === expected;
		});
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function materializePluginSource(home: string): string {
	const sourceDir = managedOpenClawProviderPluginSourceDir(home);
	if (sourceIsCurrent(sourceDir)) return sourceDir;
	withRuntimeUserFileAccess(() => {
		rmSync(sourceDir, { recursive: true, force: true });
		mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
		for (const [name, content] of pluginFiles) {
			writeFileSync(join(sourceDir, name), content, { mode: 0o600 });
		}
	});
	return sourceDir;
}

type PluginInspect = ReturnType<typeof managedOpenClawPluginInspectSchema.parse>;

function commandFailure(prefix: string, result: ReturnType<typeof spawnRuntimeUserCommand>): Error {
	const detail = String(result.stderr || result.stdout || "")
		.trim()
		.split("\n")
		.slice(-8)
		.join("\n");
	return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

function inspectPlugin(command: string, home: string): PluginInspect | null {
	const result = spawnRuntimeUserCommand(
		command,
		["plugins", "inspect", CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID, "--json"],
		home,
		home,
		{ timeoutMs: COMMAND_TIMEOUT_MS },
	);
	if (result.status !== 0) return null;
	const output = String(result.stdout);
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`OpenClaw managed provider plugin inspect returned invalid JSON: ${detail}; prefix=${JSON.stringify(
				output.trim().slice(0, 300),
			)}`,
		);
	}
	const inspected = managedOpenClawPluginInspectSchema.safeParse(parsed);
	if (!inspected.success) {
		const detail = inspected.error.issues
			.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
			.join("; ");
		throw new Error(`OpenClaw managed provider plugin inspect schema mismatch: ${detail}`);
	}
	return inspected.data;
}

function pluginOwnershipMatches(
	observation: PluginInspect,
	sourceDir: string,
	home: string,
): boolean {
	const installDir = managedOpenClawProviderPluginInstallDir(home);
	const pluginSource = resolve(observation.plugin.source);
	const relativeSource = relative(resolve(installDir), pluginSource);
	return (
		observation.plugin.id === CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID &&
		observation.plugin.version === PLUGIN_VERSION &&
		observation.install?.source === "path" &&
		observation.install.sourcePath !== undefined &&
		resolve(observation.install.sourcePath) === resolve(sourceDir) &&
		observation.install.installPath !== undefined &&
		resolve(observation.install.installPath) === resolve(installDir) &&
		relativeSource !== "" &&
		!relativeSource.startsWith("..") &&
		!isAbsolute(relativeSource)
	);
}

function pluginOwnershipDetail(
	observation: PluginInspect | null,
	sourceDir: string,
	home: string,
): string {
	return JSON.stringify({
		expected: {
			id: CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID,
			version: PLUGIN_VERSION,
			sourcePath: sourceDir,
			installPath: managedOpenClawProviderPluginInstallDir(home),
		},
		actual: observation
			? {
					id: observation.plugin.id,
					version: observation.plugin.version,
					pluginSource: observation.plugin.source,
					install: observation.install,
				}
			: null,
	});
}

function runPluginCommand(command: string, args: string[], home: string, operation: string): void {
	const result = spawnRuntimeUserCommand(command, args, home, home, {
		timeoutMs: COMMAND_TIMEOUT_MS,
	});
	if (result.status !== 0) throw commandFailure(operation, result);
}

export function openClawProviderEnvVarsSdkPath(input: {
	home: string;
	commandPath?: string | null;
	appRoot?: string | null;
}): string {
	const testOverride = process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_ENV_VARS_SDK?.trim();
	if (testOverride) {
		if (process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1") {
			throw new Error(
				"CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_ENV_VARS_SDK requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1",
			);
		}
		return testOverride;
	}
	const resolved = resolveOpenClawProviderEnvVarsSdkExport(input.home, [
		input.commandPath,
		input.appRoot,
		join(input.home, ".openclaw", "lib", "node_modules", "openclaw"),
		join(input.home, ".openclaw", "node_modules", "openclaw"),
		join(input.home, ".local", "lib", "node_modules", "openclaw"),
	]);
	if (!resolved) throw new Error("installed OpenClaw provider-env-vars SDK export is unavailable");
	return resolved;
}

const VERIFY_MARKER_HELPER = `
import { pathToFileURL } from "node:url";
const sdk = await import(pathToFileURL(process.argv[1]).href);
if (typeof sdk.listKnownProviderAuthEnvVarNames !== "function") {
  throw new Error("required public provider-env-vars export is missing");
}
const names = sdk.listKnownProviderAuthEnvVarNames();
if (!Array.isArray(names) || !names.includes(${JSON.stringify(MANAGED_AI_PROVIDER_RUNTIME_ENV)})) {
  throw new Error("managed provider env marker is not registered");
}
`;

export function requireManagedOpenClawProviderMarker(input: {
	home: string;
	commandPath?: string | null;
	appRoot?: string | null;
}): void {
	const result = spawnRuntimeUserCommand(
		"node",
		["--input-type=module", "--eval", VERIFY_MARKER_HELPER, openClawProviderEnvVarsSdkPath(input)],
		input.home,
		input.home,
	);
	if (result.status !== 0) {
		throw commandFailure("OpenClaw managed provider env marker verification failed", result);
	}
}

export function ensureManagedOpenClawProviderPlugin(input: {
	home: string;
	commandPath: string;
	appRoot?: string | null;
}): void {
	const sourceDir = materializePluginSource(input.home);
	let observation = inspectPlugin(input.commandPath, input.home);
	if (
		observation &&
		pluginOwnershipMatches(observation, sourceDir, input.home) &&
		observation.plugin.enabled &&
		observation.plugin.status === "loaded"
	) {
		try {
			requireManagedOpenClawProviderMarker(input);
			return;
		} catch {
			observation = null;
		}
	}
	if (!observation || !pluginOwnershipMatches(observation, sourceDir, input.home)) {
		runPluginCommand(
			input.commandPath,
			["plugins", "install", sourceDir, "--force"],
			input.home,
			"OpenClaw managed provider plugin install failed",
		);
		observation = inspectPlugin(input.commandPath, input.home);
		if (!observation || !pluginOwnershipMatches(observation, sourceDir, input.home)) {
			throw new Error(
				`OpenClaw managed provider plugin ownership verification failed: ${pluginOwnershipDetail(
					observation,
					sourceDir,
					input.home,
				)}`,
			);
		}
	}
	if (!observation.plugin.enabled || observation.plugin.status !== "loaded") {
		runPluginCommand(
			input.commandPath,
			["plugins", "enable", CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID],
			input.home,
			"OpenClaw managed provider plugin enable failed",
		);
		observation = inspectPlugin(input.commandPath, input.home);
	}
	if (
		!observation ||
		!pluginOwnershipMatches(observation, sourceDir, input.home) ||
		!observation.plugin.enabled ||
		observation.plugin.status !== "loaded"
	) {
		throw new Error(
			`OpenClaw managed provider plugin activation verification failed: ${pluginOwnershipDetail(
				observation,
				sourceDir,
				input.home,
			)}`,
		);
	}
	requireManagedOpenClawProviderMarker(input);
}
