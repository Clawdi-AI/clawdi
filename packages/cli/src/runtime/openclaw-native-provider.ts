import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import type { NativeProviderConnection } from "./hosted-provider-resolution";
import { openClawPluginCapabilityConsentArgs } from "./openclaw-plugin-cli";
import { openClawPluginListSchema } from "./openclaw-plugin-observation";
import { openClawConfigPatchIsApplied } from "./openclaw-provider-config";
import { spawnRuntimeUserCommand } from "./runtime-user-command";

function runNativeCommand(
	command: string,
	args: string[],
	input: string,
	home: string,
	cwd: string,
	options: { timeoutMs: number; environment: Record<string, string> },
): void {
	const result = spawnRuntimeUserCommand(command, args, home, cwd, { ...options, input });
	if (result.status !== 0) throw new Error("OpenClaw native provider configuration failed");
}
export function ensureNativeOpenClawProviderPlugins(
	connections: readonly NativeProviderConnection[],
	commandPath: string,
	home: string,
	workspaceRoot: string,
	environment: Record<string, string>,
): boolean {
	const required = new Map(
		connections.flatMap(({ routing: native }) => {
			const plugins = [[native.openclaw.plugin, native.openclaw.package] as const];
			if (native.openclaw.companion_plugin && native.openclaw.companion_package)
				plugins.push([native.openclaw.companion_plugin, native.openclaw.companion_package]);
			return plugins;
		}),
	);
	if (required.size === 0) return false;
	const run = (args: string[]) => {
		const result = spawnRuntimeUserCommand(commandPath, args, home, workspaceRoot, {
			timeoutMs: 30_000,
			environment,
		});
		return {
			status: result.status,
			stdout: String(result.stdout ?? ""),
			stderr: String(result.stderr ?? ""),
		};
	};
	const observe = () => {
		const result = run(["plugins", "list", "--json"]);
		if (result.status !== 0)
			throw new Error("Native OpenClaw provider plugins could not be inspected");
		return openClawPluginListSchema.parse(JSON.parse(String(result.stdout)));
	};
	let changed = false;
	let installed = observe();
	for (const [plugin, packageSpec] of required) {
		if (!installed.plugins.some((entry) => entry.id === plugin)) {
			// The target is absent. --force acknowledges this fixed official npm
			// source; native security policy still governs installation.
			runNativeCommand(
				commandPath,
				[
					"plugins",
					"install",
					packageSpec,
					"--force",
					"--pin",
					...openClawPluginCapabilityConsentArgs("install", run),
				],
				"",
				home,
				workspaceRoot,
				{ timeoutMs: 180_000, environment },
			);
			changed = true;
			installed = observe();
		}
		const matches = installed.plugins.filter((entry) => entry.id === plugin);
		if (matches.length !== 1 || matches[0]?.status === "error") {
			throw new Error(`Required native OpenClaw provider plugin ${plugin} is unavailable`);
		}
		if (matches[0]?.enabled !== true) {
			runNativeCommand(
				commandPath,
				["plugins", "enable", plugin, ...openClawPluginCapabilityConsentArgs("enable", run)],
				"",
				home,
				workspaceRoot,
				{ timeoutMs: 30_000, environment },
			);
			changed = true;
			installed = observe();
		}
		if (
			!installed.plugins.some(
				(entry) => entry.id === plugin && entry.enabled && entry.status === "loaded",
			)
		)
			throw new Error(`Required native OpenClaw provider plugin ${plugin} did not activate`);
	}
	return changed;
}

export function buildNativeOpenClawProviderPatch(
	connections: readonly NativeProviderConnection[],
	previousNativeIds: readonly string[],
): { config: Record<string, unknown>; providerIds: string[] } {
	const providers: Record<string, unknown> = {};
	const providerIds: string[] = [];
	for (const connection of connections) {
		if (connection.auth.kind !== "api-key") continue;
		const id = connection.routing.openclaw.provider;
		providerIds.push(id);
		providers[id] = {
			baseUrl: connection.routing.base_url,
			auth: "api-key",
			apiKey: { source: "env", provider: "clawdi-native", id: connection.auth.envName },
		};
	}
	for (const id of previousNativeIds) {
		if (!providerIds.includes(id)) providers[id] = { apiKey: null, auth: null, baseUrl: null };
	}
	return {
		providerIds,
		config: {
			...(connections.length || Object.keys(providers).length
				? {
						models: {
							...(connections.length ? { mode: "merge" } : {}),
							...(Object.keys(providers).length ? { providers } : {}),
						},
					}
				: {}),
			...(providerIds.length
				? { secrets: { providers: { "clawdi-native": { source: "env" } } } }
				: {}),
		},
	};
}

export function applyOpenClawNativeProviders(input: {
	patch: ReturnType<typeof buildNativeOpenClawProviderPatch>;
	command: string;
	context: OpenClawHostedContext;
	workspaceRoot: string;
	environment: Record<string, string>;
}): boolean {
	const { command, context, workspaceRoot, environment } = input;
	if (openClawConfigPatchIsApplied(context, input.patch.config)) return false;
	// Native credentials only: the official CLI owns merge/delete, validation and
	// locking. Catalog replacement retains the SDK's explicit size-drop handling.

	runNativeCommand(
		command,
		["config", "patch", "--stdin"],
		JSON.stringify(input.patch.config),
		context.home,
		workspaceRoot,
		{
			timeoutMs: 30_000,
			environment,
		},
	);
	return true;
}
