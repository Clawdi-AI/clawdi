import { join } from "node:path";
import type { AiProviderApiMode } from "@clawdi/shared";
import {
	getHermesRawConfigValue,
	type HermesConfigTransaction,
	reconcileHermesConfigValue,
} from "./hermes-config";
import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import { customProviderConnections, hostedProviderEnvironment } from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import { type RuntimeInstallObservation, runtimeAppRoot } from "./manifest-install";
import { canonicalJsonEqual, recordValue } from "./manifest-shared";
import { readOpenClawProviderConfig } from "./openclaw-native-provider";
import { runtimeImpactRevision } from "./runtime-impact-revision";
import { spawnRuntimeUserCommand } from "./runtime-user-command";
import { runtimeSecretValue } from "./secret-values";

export interface ConnectionProviderTransfer {
	pendingCreation?: boolean;
	envName: string;
	baseUrl: string;
	apiMode: AiProviderApiMode;
}

export interface ConnectionProviderOwnership {
	providers: Record<string, ConnectionProviderTransfer>;
	prepared?: PreparedConnectionProviderTransfers;
}

export interface PreparedConnectionProviderTransfers {
	runtime: string;
	providers: Record<string, ConnectionProviderTransfer>;
	sourceRevision: string;
	patch: Record<string, Record<string, unknown>>;
	hermesModelRouting?: { source: string; patch: Record<string, string> };
}

interface ConnectionContext {
	runtime: string;
	manifest: RuntimeManifest;
	observation: RuntimeInstallObservation;
	home: string;
	openClawContext: OpenClawHostedContext;
	workspaceRoot: string;
	hermesConfig: HermesConfigTransaction | null;
	secretValues?: Record<string, string>;
	ownership: ConnectionProviderOwnership;
}

const OPENCLAW_API: Record<AiProviderApiMode, string> = {
	openai_chat: "openai-completions",
	openai_responses: "openai-responses",
	anthropic_messages: "anthropic-messages",
	google_generate_content: "google-generative-ai",
};
const HERMES_API: Partial<Record<AiProviderApiMode, string>> = {
	openai_chat: "chat_completions",
	openai_responses: "codex_responses",
	anthropic_messages: "anthropic_messages",
};

// Public installed APIs only. Never load_pool(): it can seed/write credentials.
// NousResearch/hermes-agent@0d08cd295fd73427833ee349eb858569d4d0dd3a.
// The deployed 7a963456 baseline resolves one pool via get_custom_provider_pool_key.
const HERMES_POOL_GUARD = `
import contextlib, io, json, sys
sys.path.insert(0, sys.argv[1])
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    from agent import credential_pool
    from hermes_cli.auth import read_credential_pool
    candidates = getattr(credential_pool, "custom_provider_pool_key_candidates", None)
    legacy_key = getattr(credential_pool, "get_custom_provider_pool_key", None)
    for connection in json.load(sys.stdin):
        if callable(candidates):
            keys = candidates(connection["baseUrl"], provider_name=connection["id"])
        elif callable(legacy_key):
            key = legacy_key(connection["baseUrl"], provider_name=connection["id"])
            keys = [] if key is None else [key]
        else:
            raise ValueError("Custom provider public pool API is unavailable")
        if not isinstance(keys, (list, tuple)) or any(not isinstance(key, str) or not key for key in keys):
            raise ValueError("Custom provider public pool API returned invalid keys")
        for key in keys:
            rows = read_credential_pool(key)
            if not isinstance(rows, list) or rows:
                raise ValueError("Custom provider credential pool conflicts with connection ownership")
print("ok")
`;

function environment(input: ConnectionContext): Record<string, string> {
	const { placeholderEnv, configEnv, secretEnv } = hostedProviderEnvironment(
		input.manifest,
		input.runtime,
	);
	const result = { ...placeholderEnv, ...configEnv };
	for (const [key, ref] of Object.entries(secretEnv)) {
		const value = runtimeSecretValue(input.secretValues ?? {}, ref);
		if (!value) throw new Error("Connection provider credential is unavailable");
		result[key] = value;
	}
	return result;
}

function readProviders(input: ConnectionContext): Record<string, unknown> {
	if (input.runtime === "openclaw") {
		if (!input.observation.commandPath) throw new Error("OpenClaw config command is unavailable");
		return readOpenClawProviderConfig(
			input.observation.commandPath,
			input.openClawContext,
			input.workspaceRoot,
			environment(input),
		).providers;
	}
	if (input.runtime !== "hermes" || !input.hermesConfig)
		throw new Error("Connection runtime config is unavailable");
	const current = getHermesRawConfigValue(input.hermesConfig, "providers");
	if (!current.exists) return {};
	const providers = recordValue(current.value);
	if (!providers) throw new Error("Hermes providers must be an object");
	return providers;
}

function revision(providers: Record<string, unknown>, ids: string[]): string {
	return runtimeImpactRevision(
		Object.fromEntries(ids.sort().map((id) => [id, providers[id] ?? null])),
	);
}

function guardHermesPools(input: ConnectionContext): void {
	const connections = customProviderConnections(input.manifest, input.runtime);
	if (input.runtime !== "hermes" || connections.length === 0) return;
	const appRoot = runtimeAppRoot("hermes", input.home);
	if (!appRoot) throw new Error("Hermes application path is unavailable");
	const result = spawnRuntimeUserCommand(
		join(appRoot, "venv", "bin", "python"),
		["-c", HERMES_POOL_GUARD, appRoot],
		input.home,
		input.workspaceRoot,
		{
			environmentOverrides: { HERMES_HOME: join(input.home, ".hermes") },
			input: JSON.stringify(connections.map(({ id, baseUrl }) => ({ id, baseUrl }))),
			timeoutMs: 30_000,
			maxBufferBytes: 64 * 1024,
		},
	);
	if (result.status !== 0 || String(result.stdout).trim() !== "ok")
		throw new Error("Hermes custom provider credential conflict or unsupported public pool API");
}

function ownedOpenClawRef(value: unknown, envName: string): boolean {
	const ref = recordValue(value);
	return (
		ref?.source === "env" &&
		(ref.provider === "clawdi-connection" || ref.provider === "default") &&
		ref.id === envName
	);
}

function hasAuthenticationHeaders(value: unknown): boolean {
	return Object.keys(recordValue(value) ?? {}).some((name) =>
		["authorization", "x-api-key", "api-key", "x-goog-api-key", "cookie"].includes(
			name.toLowerCase(),
		),
	);
}

function hermesModelRoutingSource(model: Record<string, unknown> | null): string {
	return runtimeImpactRevision({
		provider: model?.provider ?? null,
		nestedProvider: recordValue(model?.default)?.provider ?? null,
		credentials: Object.fromEntries(
			["api_key", "api", "key_env", "auth_mode"].map((field) => [field, model?.[field] ?? null]),
		),
		baseUrl: model?.base_url ?? null,
		apiMode: model?.api_mode ?? null,
	});
}

/** Read-only preflight. The root coordinator must durably persist providers before apply. */
export function prepareConnectionProviderTransfers(
	input: ConnectionContext,
): PreparedConnectionProviderTransfers {
	const connections = customProviderConnections(input.manifest, input.runtime);
	for (const connection of connections) {
		if (!runtimeSecretValue(input.secretValues ?? {}, connection.secretRef))
			throw new Error("Connection provider credential is unavailable");
	}
	const current = readProviders(input);
	const providers = { ...input.ownership.providers };
	const patch: Record<string, Record<string, unknown>> = {};
	for (const connection of connections) {
		const { id, baseUrl, apiMode, envName } = connection;
		const previous = providers[id];
		const existing = recordValue(current[id]);
		const creating =
			!existing && connection.initialize && (!previous || previous.pendingCreation === true);
		if (!existing && !creating) throw new Error(`Connection provider ${id} must already exist`);
		if (current[id] !== undefined && !existing)
			throw new Error("Custom provider config must be an object");
		if (previous && previous.envName !== envName)
			throw new Error("Connection credential environment is immutable");
		if (creating) {
			const protocol = input.runtime === "openclaw" ? OPENCLAW_API[apiMode] : HERMES_API[apiMode];
			if (!protocol) throw new Error("Connection protocol is unsupported by this runtime");
			providers[id] = { envName, baseUrl, apiMode, pendingCreation: true };
			patch[id] =
				input.runtime === "openclaw"
					? {
							baseUrl,
							api: protocol,
							models: [],
							auth: "api-key",
							apiKey: { source: "env", provider: "clawdi-connection", id: envName },
						}
					: { base_url: baseUrl, transport: protocol, key_env: envName };
			continue;
		}
		if (!existing) throw new Error("Connection provider config is unavailable");
		if (
			connection.initialize &&
			!previous &&
			!(input.runtime === "openclaw"
				? ownedOpenClawRef(existing.apiKey, envName)
				: existing.key_env === envName || existing.api_key_env === envName)
		)
			throw new Error("Custom provider ID is already owned by another connection");
		const endpoint =
			input.runtime === "openclaw"
				? existing.baseUrl
				: (existing.api ?? existing.url ?? existing.base_url);
		const protocol =
			input.runtime === "openclaw"
				? (existing.api ?? "openai-completions")
				: (existing.api_mode ?? existing.transport);
		const expectedApi = input.runtime === "openclaw" ? OPENCLAW_API[apiMode] : HERMES_API[apiMode];
		if (!expectedApi) throw new Error("Connection protocol is unsupported by this runtime");
		if (!previous && (endpoint !== baseUrl || protocol !== expectedApi))
			throw new Error(`Connection provider ${id} routing changed before handoff`);
		const fields: Record<string, unknown> = {};
		if (input.runtime === "openclaw") {
			if (!Array.isArray(existing.models))
				throw new Error("Custom OpenClaw provider must retain its models array");
			if (existing.apiKey !== undefined && !ownedOpenClawRef(existing.apiKey, envName))
				throw new Error("OpenClaw connection credential ownership conflict");
			if (existing.auth !== undefined && existing.auth !== "api-key")
				throw new Error("OpenClaw connection auth mode conflict");
			if (
				existing.authHeader === false ||
				hasAuthenticationHeaders(existing.headers) ||
				existing.models.some((model) => hasAuthenticationHeaders(recordValue(model)?.headers))
			)
				throw new Error("OpenClaw connection authentication header conflict");
			fields.auth = "api-key";
			fields.apiKey = { source: "env", provider: "clawdi-connection", id: envName };
			if (previous && endpoint !== baseUrl) fields.baseUrl = baseUrl;
			if (previous && protocol !== expectedApi) fields.api = expectedApi;
		} else {
			if (
				existing.api_key ||
				existing.key_cmd ||
				(existing.key_env && existing.key_env !== envName) ||
				(existing.api_key_env && existing.api_key_env !== envName)
			)
				throw new Error("Hermes connection credential ownership conflict");
			fields.key_env = envName;
			if (previous && endpoint !== baseUrl)
				fields[
					Object.hasOwn(existing, "api")
						? "api"
						: Object.hasOwn(existing, "url")
							? "url"
							: "base_url"
				] = baseUrl;
			if (previous && protocol !== expectedApi)
				fields[Object.hasOwn(existing, "api_mode") ? "api_mode" : "transport"] = expectedApi;
		}
		providers[id] = { ...previous, envName, baseUrl, apiMode };
		patch[id] = fields;
	}
	const active = new Set(connections.map((connection) => connection.id));
	for (const [id, previous] of Object.entries(providers)) {
		if (active.has(id)) continue;
		const { pendingCreation: _pending, ...transferred } = previous;
		providers[id] = transferred;
		const existing = recordValue(current[id]);
		if (!existing) continue;
		if (input.runtime === "openclaw" && ownedOpenClawRef(existing.apiKey, previous.envName))
			patch[id] = { apiKey: null, ...(existing.auth === "api-key" ? { auth: null } : {}) };
		if (input.runtime === "hermes") {
			const refs = Object.fromEntries(
				["key_env", "api_key_env"]
					.filter((key) => existing[key] === previous.envName)
					.map((key) => [key, null]),
			);
			if (Object.keys(refs).length) patch[id] = refs;
		}
	}
	let hermesModelRouting: PreparedConnectionProviderTransfers["hermesModelRouting"];
	if (input.runtime === "hermes" && input.hermesConfig) {
		const model = recordValue(getHermesRawConfigValue(input.hermesConfig, "model").value);
		const selected = recordValue(model?.default)?.provider ?? model?.provider;
		const connection = connections.find(({ id }) => selected === id || selected === `custom:${id}`);
		if (connection) {
			if (
				["api_key", "api", "auth_mode"].some((field) => Boolean(model?.[field])) ||
				(model?.key_env && model.key_env !== connection.envName)
			)
				throw new Error("Hermes model credentials conflict with the custom connection");
			const existing = recordValue(current[connection.id]);
			const oldEndpoint =
				existing?.api ?? existing?.url ?? existing?.base_url ?? connection.baseUrl;
			const oldProtocol =
				existing?.api_mode ?? existing?.transport ?? HERMES_API[connection.apiMode];
			const modelPatch: Record<string, string> = {};
			// Hermes /model --global persists these routing mirrors. Preserve model choice;
			// update only mirrors that still match the connection they describe.
			if (model?.base_url) {
				if (
					typeof model.base_url !== "string" ||
					typeof oldEndpoint !== "string" ||
					model.base_url.replace(/\/+$/, "") !== oldEndpoint.replace(/\/+$/, "")
				)
					throw new Error("Hermes model endpoint conflicts with the custom connection");
				if (model.base_url.replace(/\/+$/, "") !== connection.baseUrl.replace(/\/+$/, ""))
					modelPatch.base_url = connection.baseUrl;
			}
			if (model?.api_mode) {
				if (model.api_mode !== oldProtocol)
					throw new Error("Hermes model protocol conflicts with the custom connection");
				const nextProtocol = HERMES_API[connection.apiMode];
				if (nextProtocol && model.api_mode !== nextProtocol) modelPatch.api_mode = nextProtocol;
			}
			hermesModelRouting = { source: hermesModelRoutingSource(model), patch: modelPatch };
		}
	}
	guardHermesPools(input);
	return {
		runtime: input.runtime,
		providers,
		sourceRevision: revision(current, Object.keys(providers)),
		patch,
		...(hermesModelRouting ? { hermesModelRouting } : {}),
	};
}

export function applyConnectionProviderTransfers(input: ConnectionContext): boolean {
	const plan = input.ownership.prepared;
	if (
		!plan ||
		plan.runtime !== input.runtime ||
		!canonicalJsonEqual(plan.providers, input.ownership.providers)
	)
		throw new Error("Connection providers require a durably prepared ownership transfer");
	const current = readProviders(input);
	if (revision(current, Object.keys(plan.providers)) !== plan.sourceRevision)
		throw new Error("Connection provider config changed after preflight");
	guardHermesPools(input);
	if (
		plan.hermesModelRouting &&
		(!input.hermesConfig ||
			hermesModelRoutingSource(
				recordValue(getHermesRawConfigValue(input.hermesConfig, "model").value),
			) !== plan.hermesModelRouting.source)
	)
		throw new Error("Hermes model routing changed after preflight");
	let changed = Object.keys(plan.hermesModelRouting?.patch ?? {}).length > 0;
	const patches: Record<string, Record<string, unknown>> = {};
	for (const [id, fields] of Object.entries(plan.patch)) {
		const existing = recordValue(current[id]) ?? {};
		const next = { ...existing };
		for (const [key, value] of Object.entries(fields)) {
			if (value === null) delete next[key];
			else next[key] = value;
		}
		if (canonicalJsonEqual(existing, next)) continue;
		changed = true;
		patches[id] = fields;
		current[id] = next;
	}
	if (!changed) return false;
	if (input.runtime === "hermes") {
		if (!input.hermesConfig) throw new Error("Hermes config command is unavailable");
		reconcileHermesConfigValue(input.hermesConfig, "providers", current);
		for (const [field, value] of Object.entries(plan.hermesModelRouting?.patch ?? {}))
			reconcileHermesConfigValue(input.hermesConfig, `model.${field}`, value);
	} else {
		if (!input.observation.commandPath) throw new Error("OpenClaw config command is unavailable");
		const config = {
			models: { providers: patches },
			...(customProviderConnections(input.manifest, input.runtime).length
				? { secrets: { providers: { "clawdi-connection": { source: "env" } } } }
				: {}),
		};
		const result = spawnRuntimeUserCommand(
			input.observation.commandPath,
			["config", "patch", "--stdin"],
			input.home,
			input.workspaceRoot,
			{ input: JSON.stringify(config), environment: environment(input), timeoutMs: 30_000 },
		);
		if (result.status !== 0) throw new Error("OpenClaw connection configuration failed");
	}
	return true;
}
