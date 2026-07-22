import { existsSync, readFileSync } from "node:fs";
import { parseDocument, parse as parseYaml } from "yaml";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "./private-file";

const HERMES_DIRECT_MODEL_FIELDS = [
	"base_url",
	"api_key",
	"api",
	"key_env",
	"api_mode",
	"auth_mode",
] as const;
const HERMES_GENERATED_PROVIDER_FIELDS = [
	"name",
	"api",
	"url",
	"base_url",
	"default_model",
	"model",
	"models",
	"transport",
	"api_mode",
	"key_env",
	"api_key",
	"type",
	"auth_type",
] as const;

export function mergeHermesConfig(configPath: string, patchContent: string): void {
	writeHermesConfig(
		configPath,
		renderHermesConfig(readHermesConfigContent(configPath), patchContent),
	);
}

export function renderHermesConfig(content: string, patchContent: string): string {
	const document = parseHermesConfig(content, "Hermes config");
	applyHermesProviderPatch(document, readHermesPatch(patchContent));
	return String(document);
}

function writeHermesConfig(configPath: string, content: string): void {
	writePrivateFileAtomic(configPath, content, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

export function mergeHermesMcpServer(
	configPath: string,
	name: string,
	server:
		| { command: string; args: string[] }
		| { url: string; transport?: string; headers?: Record<string, string> },
): void {
	writeHermesConfig(
		configPath,
		renderHermesMcpServer(readHermesConfigContent(configPath), name, server),
	);
}

export function renderHermesMcpServer(
	content: string,
	name: string,
	server:
		| { command: string; args: string[] }
		| { url: string; transport?: string; headers?: Record<string, string> },
): string {
	const document = parseHermesConfig(content, "Hermes config");
	const root = document.toJS();
	if (isPlainRecord(root) && root.mcp_servers !== undefined && !isPlainRecord(root.mcp_servers)) {
		throw new Error("Hermes config field mcp_servers must be a YAML object.");
	}
	if (!isPlainRecord(root) || !isPlainRecord(root.mcp_servers)) {
		document.set("mcp_servers", document.createNode({}));
	}
	document.setIn(["mcp_servers", name], server);
	return String(document);
}

export function mergeHermesChannelConfig(
	configPath: string,
	platforms: Record<string, Record<string, unknown>>,
): void {
	writeHermesConfig(
		configPath,
		renderHermesChannelConfig(readHermesConfigContent(configPath), platforms),
	);
}

export function renderHermesChannelConfig(
	content: string,
	platforms: Record<string, Record<string, unknown>>,
): string {
	const document = parseHermesConfig(content, "Hermes config");
	for (const [platform, config] of Object.entries(platforms)) {
		if (platform === "platforms") {
			const root = document.toJS();
			if (isPlainRecord(root) && root.platforms !== undefined && !isPlainRecord(root.platforms)) {
				throw new Error("Hermes config field platforms must be a YAML object.");
			}
			if (!isPlainRecord(root) || !isPlainRecord(root.platforms)) {
				document.set("platforms", document.createNode({}));
			}
			for (const [nestedPlatform, nestedConfig] of Object.entries(config)) {
				document.setIn(["platforms", nestedPlatform], document.createNode(nestedConfig));
			}
			continue;
		}
		document.set(platform, document.createNode(config));
	}
	return String(document);
}

export function mergeHermesRuntimeLocale(configPath: string, timezone: string): void {
	writeHermesConfig(
		configPath,
		renderHermesRuntimeLocale(readHermesConfigContent(configPath), timezone),
	);
}

export function renderHermesRuntimeLocale(content: string, timezone: string): string {
	const document = parseHermesConfig(content, "Hermes config");
	document.set("timezone", timezone);
	return String(document);
}

export function mergeHermesDashboardBasicAuth(
	configPath: string,
	username: string,
	sessionTtlSeconds: number,
): void {
	writeHermesConfig(
		configPath,
		renderHermesDashboardBasicAuth(
			readHermesConfigContent(configPath),
			username,
			sessionTtlSeconds,
		),
	);
}

export function renderHermesDashboardBasicAuth(
	content: string,
	username: string,
	sessionTtlSeconds: number,
): string {
	const document = parseHermesConfig(content, "Hermes config");
	const root = document.toJS();
	if (isPlainRecord(root) && root.dashboard !== undefined && !isPlainRecord(root.dashboard)) {
		throw new Error("Hermes config field dashboard must be a YAML object.");
	}
	if (isPlainRecord(root) && root.plugins !== undefined && !isPlainRecord(root.plugins)) {
		throw new Error("Hermes config field plugins must be a YAML object.");
	}
	if (!isPlainRecord(root) || !isPlainRecord(root.dashboard)) {
		document.set("dashboard", document.createNode({}));
	}
	document.setIn(
		["dashboard", "basic_auth"],
		document.createNode({ username, session_ttl_seconds: sessionTtlSeconds }),
	);
	const plugins = isPlainRecord(root) && isPlainRecord(root.plugins) ? root.plugins : {};
	const disabled = Array.isArray(plugins.disabled)
		? plugins.disabled.filter((value): value is string => typeof value === "string")
		: [];
	const nextDisabled = new Set(disabled.filter((value) => value !== "dashboard_auth/basic"));
	nextDisabled.add("dashboard_auth/nous");
	nextDisabled.add("dashboard_auth/self_hosted");
	if (!isPlainRecord(root) || !isPlainRecord(root.plugins)) {
		document.set("plugins", document.createNode({}));
	}
	document.setIn(["plugins", "disabled"], [...nextDisabled].sort());
	return String(document);
}

export function removeHermesMcpServer(configPath: string, name: string): void {
	if (!existsSync(configPath)) return;
	const existing = readHermesConfigContent(configPath);
	const next = renderHermesMcpServerRemoval(existing, name);
	if (next === existing) return;
	writeHermesConfig(configPath, next);
}

export function renderHermesMcpServerRemoval(content: string, name: string): string {
	const document = parseHermesConfig(content, "Hermes config");
	const root = document.toJS();
	if (isPlainRecord(root) && root.mcp_servers !== undefined && !isPlainRecord(root.mcp_servers)) {
		throw new Error("Hermes config field mcp_servers must be a YAML object.");
	}
	if (!isPlainRecord(root) || !isPlainRecord(root.mcp_servers)) return content;
	if (!Object.hasOwn(root.mcp_servers, name)) return content;
	document.deleteIn(["mcp_servers", name]);
	return String(document);
}

function readHermesConfigContent(configPath: string): string {
	return existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
}

function parseHermesConfig(content: string, label: string): ReturnType<typeof parseDocument> {
	const document = parseDocument(content);
	if (document.errors.length > 0) {
		throw new Error(`${label} contains invalid YAML: ${document.errors[0]?.message}`);
	}
	const parsed = document.toJS();
	if (parsed === null || parsed === undefined) {
		if (document.contents) {
			throw new Error(`${label} must be a YAML object`);
		}
		return document;
	}
	if (!isPlainRecord(parsed)) {
		throw new Error(`${label} must be a YAML object`);
	}
	return document;
}

function readHermesPatch(patchContent: string): Record<string, unknown> {
	const parsed = parseYaml(patchContent);
	if (!isPlainRecord(parsed)) throw new Error("Hermes projection patch must be a YAML object.");
	return parsed;
}

function applyHermesProviderPatch(
	document: ReturnType<typeof parseDocument>,
	patchConfig: Record<string, unknown>,
): void {
	const existingConfig = document.toJS();
	const root = isPlainRecord(existingConfig) ? existingConfig : {};
	validateHermesMergeRoot(root);
	const existingModel = isPlainRecord(root.model) ? root.model : {};
	const patchModel = isPlainRecord(patchConfig.model) ? patchConfig.model : {};
	const patchProviders = isPlainRecord(patchConfig.providers) ? patchConfig.providers : {};
	prepareHermesMergeRoot(document, root, {
		needsProviders: Object.keys(patchProviders).length > 0,
	});
	removeHermesDirectModelFields(document, existingModel);
	for (const [key, value] of Object.entries(patchModel)) {
		if (value === null) {
			if (Object.hasOwn(existingModel, key)) {
				document.deleteIn(["model", key]);
			}
			continue;
		}
		document.setIn(["model", key], value);
	}

	const existingProviders = isPlainRecord(root.providers) ? root.providers : {};
	for (const [providerId, patchValue] of Object.entries(patchProviders)) {
		if (patchValue === null) {
			if (Object.hasOwn(existingProviders, providerId)) {
				document.deleteIn(["providers", providerId]);
			}
			continue;
		}
		if (!isPlainRecord(patchValue)) continue;
		const existingProvider = isPlainRecord(existingProviders[providerId])
			? existingProviders[providerId]
			: {};
		if (
			Object.hasOwn(existingProviders, providerId) &&
			(existingProviders[providerId] === null || existingProviders[providerId] === undefined)
		) {
			document.setIn(["providers", providerId], document.createNode({}));
		}
		removeHermesGeneratedProviderFields(document, providerId, existingProvider);
		let wroteGeneratedField = false;
		for (const [key, value] of Object.entries(patchValue)) {
			if (value === null) {
				if (Object.hasOwn(existingProvider, key)) {
					document.deleteIn(["providers", providerId, key]);
				}
				continue;
			}
			document.setIn(["providers", providerId, key], value);
			wroteGeneratedField = true;
		}
		if (!wroteGeneratedField && !hasHermesUserOwnedProviderFields(existingProvider)) {
			document.deleteIn(["providers", providerId]);
		}
	}
}

function validateHermesMergeRoot(root: Record<string, unknown>): void {
	const providers = root.providers;
	if (providers !== undefined && providers !== null && !isPlainRecord(providers)) {
		throw new Error("Hermes config field providers must be a YAML object.");
	}
	const providerMap = isPlainRecord(providers) ? providers : {};
	for (const [providerId, provider] of Object.entries(providerMap)) {
		if (provider !== undefined && provider !== null && !isPlainRecord(provider)) {
			throw new Error(`Hermes provider ${providerId} must be a YAML object.`);
		}
	}
}

function prepareHermesMergeRoot(
	document: ReturnType<typeof parseDocument>,
	root: Record<string, unknown>,
	input: { needsProviders: boolean },
): void {
	if (Object.hasOwn(root, "model") && !isPlainRecord(root.model)) {
		document.set("model", document.createNode({}));
	}
	if (input.needsProviders && !isPlainRecord(root.providers)) {
		document.set("providers", document.createNode({}));
	}
}

function removeHermesDirectModelFields(
	document: ReturnType<typeof parseDocument>,
	input: Record<string, unknown>,
): void {
	for (const key of HERMES_DIRECT_MODEL_FIELDS) {
		if (Object.hasOwn(input, key)) document.deleteIn(["model", key]);
	}
}

function removeHermesGeneratedProviderFields(
	document: ReturnType<typeof parseDocument>,
	providerId: string,
	input: Record<string, unknown>,
): void {
	for (const key of HERMES_GENERATED_PROVIDER_FIELDS) {
		if (Object.hasOwn(input, key)) document.deleteIn(["providers", providerId, key]);
	}
}

function hasHermesUserOwnedProviderFields(input: Record<string, unknown>): boolean {
	return Object.keys(input).some(
		(key) => !(HERMES_GENERATED_PROVIDER_FIELDS as readonly string[]).includes(key),
	);
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}
