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
	const document = readHermesConfig(configPath);
	const patchConfig = readHermesPatch(patchContent);
	applyHermesProviderPatch(document, patchConfig);
	writePrivateFileAtomic(configPath, String(document), {
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
	const document = readHermesConfig(configPath);
	const root = document.toJS();
	if (isPlainRecord(root) && root.mcp_servers !== undefined && !isPlainRecord(root.mcp_servers)) {
		throw new Error("Hermes config field mcp_servers must be a YAML object.");
	}
	if (!isPlainRecord(root) || !isPlainRecord(root.mcp_servers)) {
		document.set("mcp_servers", document.createNode({}));
	}
	document.setIn(["mcp_servers", name], server);
	writePrivateFileAtomic(configPath, String(document), {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

export function mergeHermesChannelConfig(
	configPath: string,
	platforms: Record<string, Record<string, unknown>>,
): void {
	const document = readHermesConfig(configPath);
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
	writePrivateFileAtomic(configPath, String(document), {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

export function removeHermesMcpServer(configPath: string, name: string): void {
	if (!existsSync(configPath)) return;
	const document = readHermesConfig(configPath);
	const root = document.toJS();
	if (isPlainRecord(root) && root.mcp_servers !== undefined && !isPlainRecord(root.mcp_servers)) {
		throw new Error("Hermes config field mcp_servers must be a YAML object.");
	}
	if (!isPlainRecord(root) || !isPlainRecord(root.mcp_servers)) return;
	if (!Object.hasOwn(root.mcp_servers, name)) return;
	document.deleteIn(["mcp_servers", name]);
	writePrivateFileAtomic(configPath, String(document), {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

function readHermesConfig(configPath: string): ReturnType<typeof parseDocument> {
	const content = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
	const document = parseDocument(content);
	if (document.errors.length > 0) {
		throw new Error(`Hermes config contains invalid YAML: ${document.errors[0]?.message}`);
	}
	const parsed = document.toJS();
	if (parsed === null || parsed === undefined) {
		if (document.contents) {
			throw new Error(`Hermes config must be a YAML object: ${configPath}`);
		}
		return document;
	}
	if (!isPlainRecord(parsed)) {
		throw new Error(`Hermes config must be a YAML object: ${configPath}`);
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
	prepareHermesMergeRoot(document, root);
	const existingModel = isPlainRecord(root.model) ? root.model : {};
	const patchModel = isPlainRecord(patchConfig.model) ? patchConfig.model : {};
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
	const patchProviders = isPlainRecord(patchConfig.providers) ? patchConfig.providers : {};
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
		for (const [key, value] of Object.entries(patchValue)) {
			document.setIn(["providers", providerId, key], value);
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
): void {
	if (Object.hasOwn(root, "model") && !isPlainRecord(root.model)) {
		document.set("model", document.createNode({}));
	}
	if (Object.hasOwn(root, "providers") && root.providers === null) {
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

function isPlainRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}
