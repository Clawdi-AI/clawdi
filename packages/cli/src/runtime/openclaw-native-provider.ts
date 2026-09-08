import { readFileSync } from "node:fs";
import { nativeAiProviderForRuntime } from "@clawdi/shared";
import JSON5 from "json5";
import { z } from "zod";
import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import type { NativeProviderConnection } from "./hosted-provider-resolution";
import { openClawPluginCapabilityConsentArgs } from "./openclaw-plugin-cli";
import { openClawPluginListSchema } from "./openclaw-plugin-observation";
import { openClawConfigPatchIsApplied } from "./openclaw-provider-config";
import { spawnRuntimeUserCommand } from "./runtime-user-command";

const nativeProviderConfigSchema = z.object({
	baseUrl: z.string(),
	auth: z.literal("api-key"),
	apiKey: z.strictObject({
		source: z.literal("env"),
		provider: z.literal("clawdi-native"),
		id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	}),
});

// Exact absence reports from published OpenClaw 2026.7.1-2 and 2026.9.2.
// Both are emitted only after config validation, when the requested path is absent.
const MISSING_MODELS_STDERR =
	"Config path not found: models. Run openclaw config validate to inspect config shape.\n";
const missingModelsReportSchema = z.strictObject({
	ok: z.literal(false),
	error: z.strictObject({
		type: z.literal("cli_error"),
		message: z.literal(
			"Config path is valid but unset: models. The runtime default applies until you set an authored value with openclaw config set models <value>.",
		),
	}),
});

function containsConfigInclude(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsConfigInclude);
	if (value === null || typeof value !== "object") return false;
	return Object.hasOwn(value, "$include") || Object.values(value).some(containsConfigInclude);
}

/** Recover owned writes when service activation failed before authority commit. */
export function discoverNativeOpenClawProviderIds(
	command: string,
	context: OpenClawHostedContext,
	workspaceRoot: string,
	environment: Record<string, string>,
): string[] {
	let content: string;
	try {
		content = readFileSync(context.configPath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw new Error("OpenClaw native provider ownership could not be inspected");
	}
	try {
		const record = z.record(z.string(), z.unknown());
		const root = record.parse(JSON5.parse(content));
		const models = root.models === undefined ? {} : record.parse(root.models);
		const included = Object.hasOwn(root, "$include") || containsConfigInclude(models);
		let providers: Record<string, unknown>;
		if (included) {
			// Native patch can write into includes. Let OpenClaw resolve them; config
			// get preserves env SecretRef source/provider while redacting only its ID.
			const childEnvironment: Record<string, string> = {
				...environment,
				NO_COLOR: "1",
				CLICOLOR: "0",
			};
			delete childEnvironment.FORCE_COLOR;
			delete childEnvironment.CLICOLOR_FORCE;
			const result = spawnRuntimeUserCommand(
				command,
				["config", "get", "models", "--json"],
				context.home,
				workspaceRoot,
				{
					environment: childEnvironment,
					environmentOverrides: { FORCE_COLOR: undefined, CLICOLOR_FORCE: undefined },
					timeoutMs: 30_000,
					maxBufferBytes: 16 * 1024 * 1024,
				},
			);
			if (result.status !== 0) {
				if (
					result.status === 1 &&
					!result.error &&
					((result.stdout === "" && result.stderr === MISSING_MODELS_STDERR) ||
						(result.stderr === "" &&
							missingModelsReportSchema.safeParse(JSON.parse(String(result.stdout))).success))
				)
					return [];
				throw new Error("Included provider config is unavailable");
			}
			const resolvedModels = record.parse(JSON.parse(String(result.stdout)));
			providers =
				resolvedModels.providers === undefined ? {} : record.parse(resolvedModels.providers);
		} else {
			providers = models.providers === undefined ? {} : record.parse(models.providers);
		}
		return Object.entries(providers).flatMap(([id, value]) => {
			const parsed = nativeProviderConfigSchema.safeParse(value);
			if (!parsed.success) return [];
			const routing = nativeAiProviderForRuntime("openclaw", id, parsed.data.baseUrl);
			return routing &&
				(routing.runtime_env_name === parsed.data.apiKey.id ||
					(included && parsed.data.apiKey.id === "__OPENCLAW_REDACTED__"))
				? [id]
				: [];
		});
	} catch {
		throw new Error("OpenClaw native provider ownership could not be inspected");
	}
}

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
