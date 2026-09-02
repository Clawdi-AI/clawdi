import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MANAGED_AI_PROVIDER_RUNTIME_ENV } from "@clawdi/shared";
import { openClawPluginInspectSchema } from "./openclaw-plugin-observation";
import { spawnRuntimeUserCommand } from "./runtime-user-command";

export const LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID = "clawdi-managed-provider";

const COMMAND_TIMEOUT_MS = 120_000;
const LEGACY_PLUGIN_VERSION = "1.0.0";

const legacyPluginFiles = new Map<string, string>([
	[
		"index.js",
		`${[
			"export default {",
			`  id: ${JSON.stringify(LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID)},`,
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
				id: LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID,
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
				version: LEGACY_PLUGIN_VERSION,
				private: true,
				type: "module",
				openclaw: { extensions: ["./index.js"] },
			},
			null,
			2,
		)}\n`,
	],
]);

type PluginInspect = ReturnType<typeof openClawPluginInspectSchema.parse>;

function commandFailure(prefix: string, result: ReturnType<typeof spawnRuntimeUserCommand>): Error {
	const detail = String(result.stderr || result.stdout || "")
		.trim()
		.split("\n")
		.slice(-8)
		.join("\n");
	return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

function legacyPluginDirectoryMatches(directory: string): boolean {
	try {
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		const entries = readdirSync(directory).sort();
		if (entries.length !== legacyPluginFiles.size) return false;
		return entries.every((entry) => {
			const expected = legacyPluginFiles.get(entry);
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

function inspectLegacyPlugin(command: string, home: string): PluginInspect | null {
	const result = spawnRuntimeUserCommand(
		command,
		["plugins", "inspect", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID, "--json"],
		home,
		home,
		{ timeoutMs: COMMAND_TIMEOUT_MS },
	);
	if (result.status !== 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(result.stdout)) as unknown;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`OpenClaw legacy provider plugin inspect returned invalid JSON: ${detail}`);
	}
	const inspected = openClawPluginInspectSchema.safeParse(parsed);
	if (!inspected.success) {
		throw new Error("OpenClaw legacy provider plugin inspect returned an incompatible result");
	}
	return inspected.data;
}

function legacyPluginOwnershipMatches(
	observation: PluginInspect,
	sourceDir: string,
	installDir: string,
): boolean {
	const pluginSource = resolve(observation.plugin.source);
	const relativeSource = relative(resolve(installDir), pluginSource);
	return (
		observation.plugin.id === LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID &&
		observation.install.source === "path" &&
		observation.install.sourcePath !== undefined &&
		resolve(observation.install.sourcePath) === resolve(sourceDir) &&
		observation.install.installPath !== undefined &&
		resolve(observation.install.installPath) === resolve(installDir) &&
		relativeSource !== "" &&
		!relativeSource.startsWith("..") &&
		!isAbsolute(relativeSource)
	);
}

export function removeLegacyManagedOpenClawProviderPlugin(input: {
	home: string;
	stateRoot: string;
	commandPath: string;
}): void {
	const sourceDir = join(
		input.stateRoot,
		"managed-sources",
		LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID,
	);
	const installDir = join(input.stateRoot, "extensions", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID);
	if (!existsSync(sourceDir) && !existsSync(installDir)) return;

	let observation = inspectLegacyPlugin(input.commandPath, input.home);
	if (
		!observation &&
		legacyPluginDirectoryMatches(sourceDir) &&
		legacyPluginDirectoryMatches(installDir)
	) {
		const consent = spawnRuntimeUserCommand(
			input.commandPath,
			["plugins", "enable", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID, "--accept-capabilities"],
			input.home,
			input.home,
			{ timeoutMs: COMMAND_TIMEOUT_MS },
		);
		if (consent.status !== 0) {
			throw commandFailure("OpenClaw legacy provider plugin capability consent failed", consent);
		}
		observation = inspectLegacyPlugin(input.commandPath, input.home);
	}

	if (observation) {
		if (!legacyPluginOwnershipMatches(observation, sourceDir, installDir)) {
			throw new Error("refusing to remove an unmanaged OpenClaw provider plugin");
		}
		const result = spawnRuntimeUserCommand(
			input.commandPath,
			["plugins", "uninstall", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID, "--force"],
			input.home,
			input.home,
			{ timeoutMs: COMMAND_TIMEOUT_MS },
		);
		if (result.status !== 0) {
			throw commandFailure("OpenClaw legacy provider plugin uninstall failed", result);
		}
	} else if (existsSync(installDir)) {
		throw new Error("OpenClaw legacy provider plugin installation cannot be verified");
	}

	if (existsSync(installDir)) {
		throw new Error("OpenClaw legacy provider plugin uninstall left its install directory behind");
	}
	rmSync(sourceDir, { recursive: true, force: true });
}
