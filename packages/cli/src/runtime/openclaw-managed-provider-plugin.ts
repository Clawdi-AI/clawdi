import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MANAGED_AI_PROVIDER_RUNTIME_ENV } from "@clawdi/shared";
import {
	OPENCLAW_PROVIDER_ENV_VARS_EXPORTS,
	openClawSdkFunctionGuard,
} from "../lib/codex-oauth-native-store";
import {
	CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID,
	type OpenClawHostedContext,
} from "./hosted-openclaw-context";
import { openClawPluginInspectSchema } from "./openclaw-plugin-observation";
import { spawnRuntimeUserCommand } from "./runtime-user-command";

export { CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID } from "./hosted-openclaw-context";

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

function pluginDirectoryIsCurrent(directory: string): boolean {
	try {
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		const entries = readdirSync(directory).sort();
		if (entries.length !== pluginFiles.size) return false;
		return entries.every((entry) => {
			const expected = pluginFiles.get(entry);
			if (expected === undefined) return false;
			const path = join(directory, entry);
			const file = lstatSync(path);
			return file.isFile() && !file.isSymbolicLink() && readFileSync(path, "utf8") === expected;
		});
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function materializePluginDirectory(directory: string): string {
	if (pluginDirectoryIsCurrent(directory)) return directory;
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	for (const [name, content] of pluginFiles) {
		writeFileSync(join(directory, name), content, { mode: 0o600 });
	}
	return directory;
}

function materializePluginSource(context: OpenClawHostedContext): string {
	return materializePluginDirectory(context.providerPlugin.sourceDir);
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
	context: OpenClawHostedContext,
): boolean {
	const installDir = context.providerPlugin.installDir;
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
	context: OpenClawHostedContext,
): string {
	return JSON.stringify({
		expected: {
			id: CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID,
			version: PLUGIN_VERSION,
			sourcePath: sourceDir,
			installPath: context.providerPlugin.installDir,
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

const VERIFY_MARKER_HELPER = `
import { pathToFileURL } from "node:url";
const sdk = await import(pathToFileURL(process.argv[1]).href);
if (${openClawSdkFunctionGuard("sdk", OPENCLAW_PROVIDER_ENV_VARS_EXPORTS)}) {
  throw new Error("required public provider-env-vars export is missing");
}
const names = sdk.listKnownProviderAuthEnvVarNames();
if (!Array.isArray(names) || !names.includes(${JSON.stringify(MANAGED_AI_PROVIDER_RUNTIME_ENV)})) {
  throw new Error("managed provider env marker is not registered");
}
`;

function requireManagedOpenClawProviderMarker(context: OpenClawHostedContext): void {
	const result = spawnRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			VERIFY_MARKER_HELPER,
			context.requireSdkExport("providerEnvVars"),
		],
		context.home,
		context.home,
	);
	if (result.status !== 0) {
		throw commandFailure("OpenClaw managed provider env marker verification failed", result);
	}
}

export function ensureManagedOpenClawProviderPlugin(input: {
	context: OpenClawHostedContext;
	commandPath: string;
}): void {
	const sourceDir = materializePluginSource(input.context);
	let observation = inspectPlugin(input.commandPath, input.context.home);
	if (
		observation &&
		pluginOwnershipMatches(observation, sourceDir, input.context) &&
		observation.plugin.enabled &&
		observation.plugin.status === "loaded"
	) {
		try {
			requireManagedOpenClawProviderMarker(input.context);
			return;
		} catch {
			observation = null;
		}
	}
	if (!observation || !pluginOwnershipMatches(observation, sourceDir, input.context)) {
		runPluginCommand(
			input.commandPath,
			["plugins", "install", sourceDir, "--force"],
			input.context.home,
			"OpenClaw managed provider plugin install failed",
		);
		observation = inspectPlugin(input.commandPath, input.context.home);
		if (!observation || !pluginOwnershipMatches(observation, sourceDir, input.context)) {
			throw new Error(
				`OpenClaw managed provider plugin ownership verification failed: ${pluginOwnershipDetail(
					observation,
					sourceDir,
					input.context,
				)}`,
			);
		}
	}
	if (!observation.plugin.enabled || observation.plugin.status !== "loaded") {
		runPluginCommand(
			input.commandPath,
			["plugins", "enable", CLAWDI_MANAGED_OPENCLAW_PROVIDER_PLUGIN_ID],
			input.context.home,
			"OpenClaw managed provider plugin enable failed",
		);
		observation = inspectPlugin(input.commandPath, input.context.home);
	}
	if (
		!observation ||
		!pluginOwnershipMatches(observation, sourceDir, input.context) ||
		!observation.plugin.enabled ||
		observation.plugin.status !== "loaded"
	) {
		throw new Error(
			`OpenClaw managed provider plugin activation verification failed: ${pluginOwnershipDetail(
				observation,
				sourceDir,
				input.context,
			)}`,
		);
	}
	requireManagedOpenClawProviderMarker(input.context);
}
