import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_AI_PROVIDER_RUNTIME_ENV } from "@clawdi/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildAgentTargetProjection } from "../lib/ai-provider-projection";
import { writePrivateFileAtomic } from "../lib/private-file";
import { isValidSemver } from "../lib/semver";
import {
	getHermesRawConfigValue,
	getHermesResolvedConfigValue,
	type HermesConfigCommandContext,
	reconcileHermesConfigValue,
} from "./hermes-config";
import { normalizeSecretRef } from "./hosted-egress-profiles";
import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import {
	agentTargetProjectionInput,
	type HostedAiProviderProjectionInput,
	hostedAiProviderCatalog,
	hostedProviderRequiresApiKey,
} from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import { type RuntimeInstallObservation, tail } from "./manifest-install";
import { removeOpenClawManagedProviderAuthProfiles } from "./manifest-oauth";
import { hermesConfigContext } from "./manifest-runtime-config";
import { canonicalJsonEqual, isPlainRecord, recordValue, stringValue } from "./manifest-shared";
import type { RuntimePaths } from "./paths";
import { runtimeImpactRevision } from "./runtime-impact-revision";
import {
	commandExists,
	enforceRuntimeUserOwnership,
	executableExists,
	makeRuntimeUserOwned,
	runRuntimeUserCommand,
	runtimeUserDirectoryOwnership,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
import { runtimeSecretValue } from "./secret-values";

const CODEX_BOOTSTRAP_TIMEOUT_MS = 600_000;

export function providerHealthReasons(
	provider: Record<string, unknown>,
	secretAvailable: boolean | null,
): string[] {
	const reasons: string[] = [];
	const status = stringValue(provider.status);
	if (status && status !== "ok") {
		reasons.push(`provider_${status}`);
	}
	const error = recordValue(provider.error);
	const errorCode = error ? stringValue(error.code) : null;
	if (errorCode) {
		reasons.push(errorCode);
	}
	const baseUrl = stringValue(provider.baseUrl);
	if (!baseUrl) {
		reasons.push("base_url_missing");
	} else {
		try {
			new URL(baseUrl);
		} catch {
			reasons.push("base_url_invalid");
		}
	}
	if (!stringValue(provider.model) && !providerHasModels(provider)) {
		reasons.push("model_missing");
	}
	const apiMode = stringValue(provider.apiMode);
	if (baseUrl && isOpenAiCompatibleMode(apiMode)) {
		try {
			const parsed = new URL(baseUrl);
			if (!parsed.pathname || parsed.pathname === "/") {
				reasons.push("base_url_path_missing");
			}
		} catch {
			// Already reported as base_url_invalid above.
		}
	}
	if (stringValue(provider.apiKeySecretRef) && secretAvailable === false) {
		reasons.push("secret_missing");
	}
	if (hostedProviderRequiresApiKey(provider) && !stringValue(provider.apiKeySecretRef)) {
		reasons.push("api_key_secret_ref_missing");
	}
	return reasons;
}
function providerHasModels(provider: Record<string, unknown>): boolean {
	return (
		Array.isArray(provider.models) &&
		provider.models.some((model) => {
			const entry = recordValue(model);
			return Boolean(entry && stringValue(entry.id));
		})
	);
}
function isOpenAiCompatibleMode(apiMode: string | null): boolean {
	return apiMode === "openai_chat" || apiMode === "openai_responses";
}
interface HostedAiProviderProjectionResult {
	path: string | null;
	revision: string | null;
	providerIds: string[];
}
const CODEX_MANAGED_PROVIDER_ID = "clawdi";
export const CODEX_MANAGED_PROVIDER_CONFIG_FILE = "config.toml";
const CODEX_BOOTSTRAP_PACKAGE_VERSION = "0.146.0";
const CODEX_BOOTSTRAP_PACKAGE_SPEC = `@openai/codex@${CODEX_BOOTSTRAP_PACKAGE_VERSION}`;
interface HostedCodexManagedProvider {
	baseUrl: string;
}
export function applyHostedAiProviderProjection(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	home: string,
	openClawContext: OpenClawHostedContext,
	workspaceRoot: string,
	previousProviderIds: readonly string[],
	openClawOwnerBrowserBootstrapSupported: boolean,
): HostedAiProviderProjectionResult {
	if (!observation.enabled || observation.status === "install_failed" || !observation.commandPath) {
		return { path: null, revision: null, providerIds: [] };
	}
	const projectionInput = agentTargetProjectionInput(hostedAiProviderCatalog(manifest, name));
	assertHostedProviderProjectionMode(name, manifest, projectionInput);
	if (manifest.runtimes[name]?.providerMode === "configured" && !projectionInput) {
		if (name === "openclaw") {
			applyOpenClawGatewayHostedProjection(
				observation.commandPath,
				manifest,
				secretValues,
				openClawContext,
				workspaceRoot,
				openClawOwnerBrowserBootstrapSupported,
			);
		}
		return { path: null, revision: null, providerIds: [...previousProviderIds] };
	}
	if (name === "hermes") {
		return applyHostedHermesAiProviderProjection(
			observation,
			projectionInput,
			previousProviderIds,
			home,
			workspaceRoot,
		);
	}
	if (name === "openclaw") {
		applyOpenClawGatewayHostedProjection(
			observation.commandPath,
			manifest,
			secretValues,
			openClawContext,
			workspaceRoot,
			openClawOwnerBrowserBootstrapSupported,
		);
		const providerPatch = buildOpenClawHostedProviderPatch(projectionInput, previousProviderIds);
		if (providerPatch.apply) {
			applyOpenClawHostedProviderPatch(providerPatch, openClawContext, workspaceRoot);
		}
		if (openClawContext.managedApiKeyProjection) {
			if (openClawContext.agentDirs.managed.length === 0) {
				throw new Error(
					"OpenClaw managed provider-auth stores were not transactionally discovered",
				);
			}
			removeOpenClawManagedProviderAuthProfiles(openClawContext, workspaceRoot);
		}
		return {
			path: observation.commandPath,
			revision: null,
			providerIds: providerPatch.providerIds,
		};
	}
	return { path: null, revision: null, providerIds: [] };
}
export function previewHostedAiProviderProjectionRevision(
	name: string,
	observation: RuntimeInstallObservation,
	manifest: RuntimeManifest,
	home: string,
	previousProviderIds: readonly string[],
): string | null {
	if (
		(name !== "openclaw" && name !== "hermes") ||
		!observation.enabled ||
		observation.status === "install_failed" ||
		!observation.commandPath
	) {
		return null;
	}
	const projectionInput = agentTargetProjectionInput(hostedAiProviderCatalog(manifest, name));
	assertHostedProviderProjectionMode(name, manifest, projectionInput);
	if (manifest.runtimes[name]?.providerMode === "configured" && !projectionInput) {
		return null;
	}
	if (name === "openclaw") {
		const providerPatch = buildOpenClawHostedProviderPatch(projectionInput, previousProviderIds);
		if (!projectionInput) {
			return runtimeImpactRevision({
				openClawProviderProjection: "delete",
				patch: JSON.parse(providerPatch.content) as unknown,
			});
		}
		return runtimeImpactRevision({
			openClawProviderProjection: "json-patch",
			patch: providerProjectionProgramImpact(
				"openclaw",
				JSON.parse(providerPatch.content) as unknown,
				projectionInput,
			),
		});
	}
	return applyHostedHermesAiProviderProjection(
		observation,
		projectionInput,
		previousProviderIds,
		home,
		home,
		false,
	).revision;
}
function providerProjectionProgramImpact(
	runtime: "openclaw" | "hermes",
	patch: unknown,
	projectionInput: HostedAiProviderProjectionInput,
): unknown {
	const root = recordValue(patch);
	const managedProviderIds = new Set(
		projectionInput.catalog.providers
			.filter((provider) => provider.managed_by === "clawdi")
			.map((provider) => provider.id),
	);
	if (!root || managedProviderIds.size === 0) return patch;

	const providerContainer = runtime === "openclaw" ? recordValue(root.models) : root;
	if (!providerContainer) return patch;
	const providers = recordValue(providerContainer.providers);
	if (!providers) return patch;
	const programProviders = Object.fromEntries(
		Object.entries(providers).map(([providerId, provider]) => {
			const providerConfig = recordValue(provider);
			if (!managedProviderIds.has(providerId) || !providerConfig) return [providerId, provider];
			const { models: _models, ...programConfig } = providerConfig;
			return [providerId, programConfig];
		}),
	);
	if (runtime === "openclaw") {
		return { ...root, models: { ...providerContainer, providers: programProviders } };
	}
	return { ...root, providers: programProviders };
}
export function applyHostedCodexManagedProviderProjection(
	manifest: RuntimeManifest,
	home: string,
	codexCli: Record<string, string> | null,
): HostedAiProviderProjectionResult {
	const provider = hostedCodexManagedProvider(manifest);
	if (!provider) return { path: null, revision: null, providerIds: [] };

	const codexHome = hostedCodexHome(home);
	enforceRuntimeUserOwnership(
		runtimeUserDirectoryOwnership(codexHome, { mode: 0o700, ancestorsUnder: home }),
	);
	const configPath = join(codexHome, CODEX_MANAGED_PROVIDER_CONFIG_FILE);
	const configContent = hostedCodexManagedConfigToml(provider);
	writePrivateFileAtomic(configPath, configContent, { mode: 0o600, dirMode: 0o700 });
	makeRuntimeUserOwned(configPath);

	return {
		path: configPath,
		providerIds: [CODEX_MANAGED_PROVIDER_ID],
		revision: runtimeImpactRevision({
			codexManagedProviderProjection: CODEX_MANAGED_PROVIDER_CONFIG_FILE,
			configContent,
			codexCli,
		}),
	};
}
export function assertHostedProviderProjectionMode(
	runtimeName: string,
	manifest: RuntimeManifest,
	projectionInput: HostedAiProviderProjectionInput | null,
): void {
	const providerMode = manifest.runtimes[runtimeName]?.providerMode;
	if (providerMode === "unmanaged" && projectionInput) {
		throw new Error(`runtime ${runtimeName} unmanaged provider mode has a provider projection`);
	}
}
export function hostedCodexManagedProvider(
	manifest: RuntimeManifest,
): HostedCodexManagedProvider | null {
	const terminalTooling = recordValue(manifest.projection?.terminalTooling);
	const codex = recordValue(terminalTooling?.codex);
	const provider = recordValue(codex?.provider);
	const primaryModel = recordValue(codex?.primary_model);
	const providerId = stringValue(codex?.provider_id);
	const baseUrl = stringValue(provider?.baseUrl);
	const apiMode = stringValue(provider?.apiMode);
	const primaryModelName = stringValue(primaryModel?.model);
	if (
		codex?.enabled !== true ||
		!provider ||
		provider.managed_by !== "clawdi" ||
		apiMode !== "openai_responses" ||
		stringValue(provider.runtimeEnvName) !== MANAGED_AI_PROVIDER_RUNTIME_ENV ||
		normalizeSecretRef(stringValue(provider.apiKeySecretRef)) !== "secret://tool.codex.apiKey" ||
		!providerId ||
		stringValue(primaryModel?.provider_id) !== providerId ||
		!baseUrl ||
		!primaryModelName
	) {
		return null;
	}
	return { baseUrl };
}
export function hostedCodexHome(home: string): string {
	return join(home, ".codex");
}
export function hostedCodexManagedConfigToml(provider: HostedCodexManagedProvider): string {
	const lines = ["# Generated by Clawdi hosted runtime. Do not put API keys in this file."];
	lines.push(
		`model_provider = ${quoteTomlString(CODEX_MANAGED_PROVIDER_ID)}`,
		"",
		`[model_providers.${CODEX_MANAGED_PROVIDER_ID}]`,
		`name = ${quoteTomlString("clawdi")}`,
		`base_url = ${quoteTomlString(provider.baseUrl)}`,
		`env_key = ${quoteTomlString(MANAGED_AI_PROVIDER_RUNTIME_ENV)}`,
		'wire_api = "responses"',
		"",
	);
	return lines.join("\n");
}
export function ensureHostedCodexCli(paths: RuntimePaths): Record<string, string> | null {
	if (process.env.CLAWDI_CODEX_INSTALL_DISABLED === "1") return null;
	const npmPrefix = paths.userNpmPrefix;
	const realBin = join(npmPrefix, "bin", "codex");
	let installedVersion = hostedCodexInstalledVersion(npmPrefix);
	const bootstrapRequired = installedVersion === null || !executableExists(realBin);
	if (bootstrapRequired) {
		installHostedCodexBootstrap(CODEX_BOOTSTRAP_PACKAGE_SPEC, npmPrefix, paths);
		installedVersion = hostedCodexInstalledVersion(npmPrefix);
		if (installedVersion !== CODEX_BOOTSTRAP_PACKAGE_VERSION) {
			throw new Error(
				`Codex bootstrap installed version ${installedVersion ?? "unknown"}; expected ${CODEX_BOOTSTRAP_PACKAGE_VERSION}`,
			);
		}
		if (!executableExists(realBin)) {
			throw new Error(`Codex bootstrap did not create ${realBin}`);
		}
	}
	if (installedVersion === null) throw new Error("Codex package metadata is unavailable");
	return {
		commandPath: realBin,
		npmPrefix,
		bootstrapPackageSpec: CODEX_BOOTSTRAP_PACKAGE_SPEC,
		installedVersion,
		realBin,
	};
}
function hostedCodexInstalledVersion(npmPrefix: string): string | null {
	const packageJsonPath = join(
		npmPrefix,
		"lib",
		"node_modules",
		"@openai",
		"codex",
		"package.json",
	);
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || !("version" in parsed)) return null;
		return typeof parsed.version === "string" && isValidSemver(parsed.version)
			? parsed.version
			: null;
	} catch {
		return null;
	}
}
function installHostedCodexBootstrap(
	packageSpec: string,
	npmPrefix: string,
	paths: RuntimePaths,
): void {
	if (!commandExists("npm")) {
		throw new Error("Codex bootstrap requires npm on PATH");
	}
	withRuntimeUserFileAccess(() => mkdirSync(npmPrefix, { recursive: true }));
	const result = spawnRuntimeUserCommand(
		"npm",
		[
			"install",
			"-g",
			"--prefix",
			npmPrefix,
			"--ignore-scripts",
			"--fetch-retries",
			"2",
			"--fetch-retry-mintimeout",
			"1000",
			"--fetch-retry-maxtimeout",
			"10000",
			"--fetch-timeout",
			"60000",
			"--omit=dev",
			"--no-audit",
			"--no-fund",
			"--no-update-notifier",
			packageSpec,
		],
		paths.userHome,
		paths.userHome,
		{ timeoutMs: CODEX_BOOTSTRAP_TIMEOUT_MS },
	);
	if (result.status !== 0) {
		throw new Error(
			`Codex bootstrap failed: ${tail(result.stderr?.toString()) ?? tail(result.stdout?.toString()) ?? "npm failed"}`,
		);
	}
}
function applyHostedHermesAiProviderProjection(
	observation: RuntimeInstallObservation,
	projectionInput: HostedAiProviderProjectionInput | null,
	previousProviderIds: readonly string[],
	home: string,
	workspaceRoot: string,
	apply = true,
): HostedAiProviderProjectionResult {
	const configPath = join(home, ".hermes", "config.yaml");
	if (!projectionInput) {
		const deletedProviderIds = staleProviderIds(new Set(previousProviderIds), new Set());
		if (apply && deletedProviderIds.length > 0) {
			applyHermesProviderConfig(
				hermesConfigContext(observation, home, workspaceRoot),
				{},
				deletedProviderIds,
			);
		}
		return {
			path: null,
			providerIds: [],
			revision: runtimeImpactRevision({
				hermesProviderProjection: "none",
				deletedProviderIds,
			}),
		};
	}

	const commandPath = observation.commandPath;
	if (!commandPath) return { path: null, revision: null, providerIds: [] };
	const projection = buildAgentTargetProjection(
		"hermes",
		projectionInput.catalog,
		projectionInput.primaryModel,
		{ freezeManagedModelCatalog: true },
	);
	const file = projection.files.find((entry) => entry.path.endsWith(".hermes.yaml"));
	if (!file) throw new Error("Hermes projection did not include a config merge YAML file.");
	const activeProviderIds = [...providerIdsFromPatch("hermes", file.content)].sort();
	const deletedProviderIds = staleProviderIds(
		new Set(previousProviderIds),
		new Set(activeProviderIds),
	);
	const patchContent = mergeProviderDeletes("hermes", file.content, deletedProviderIds);
	if (apply) {
		const patch = parseYaml(file.content) as unknown;
		const root = recordValue(patch);
		if (!root) throw new Error("Hermes projection patch must be a YAML object.");
		applyHermesProviderConfig(
			hermesConfigContext(observation, home, workspaceRoot),
			root,
			deletedProviderIds,
		);
	}
	return {
		path: configPath,
		providerIds: activeProviderIds,
		revision: runtimeImpactRevision({
			hermesProviderProjection: "yaml-merge",
			patch: providerProjectionProgramImpact("hermes", parseYaml(patchContent), projectionInput),
		}),
	};
}
function quoteTomlString(value: string): string {
	return JSON.stringify(value);
}
export interface OpenClawHostedProviderPatch {
	apply: boolean;
	content: string;
	providerIds: string[];
}
const OPENCLAW_CONFIG_MUTATION_HELPER = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const sdk = await import(pathToFileURL(process.argv[1]).href);
if (
  typeof sdk.readConfigFileSnapshotForWrite !== "function" ||
  typeof sdk.mutateConfigFile !== "function"
) {
  throw new Error("required public config-mutation export is missing");
}
const patch = JSON.parse(readFileSync(0, "utf8"));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
if (!isRecord(patch)) throw new Error("OpenClaw provider patch must be an object");
const blockedKeys = new Set(["__proto__", "constructor", "prototype"]);
const explicitSetPaths = [];
const unsetPaths = [];
const applyMergePatch = (target, source, path = []) => {
  for (const [key, value] of Object.entries(source)) {
    if (blockedKeys.has(key)) throw new Error("OpenClaw provider patch contains a blocked key");
    const nextPath = [...path, key];
    if (value === null) {
      delete target[key];
      unsetPaths.push(nextPath);
    } else if (path.length === 2 && path[0] === "models" && path[1] === "providers") {
      target[key] = structuredClone(value);
      explicitSetPaths.push(nextPath);
    } else if (isRecord(value)) {
      if (!isRecord(target[key])) target[key] = {};
      if (Object.keys(value).length === 0) explicitSetPaths.push(nextPath);
      applyMergePatch(target[key], value, nextPath);
    } else {
      target[key] = structuredClone(value);
      explicitSetPaths.push(nextPath);
    }
  }
};
const configRead = await sdk.readConfigFileSnapshotForWrite({ skipPluginValidation: true });
const snapshot = configRead?.snapshot;
if (!snapshot || snapshot.valid !== true || !isRecord(snapshot.sourceConfig)) {
  throw new Error("OpenClaw config snapshot is unavailable for provider projection");
}
const projected = structuredClone(snapshot.sourceConfig);
applyMergePatch(projected, patch);
if (isDeepStrictEqual(projected, snapshot.sourceConfig)) process.exit(0);
explicitSetPaths.length = 0;
unsetPaths.length = 0;
await sdk.mutateConfigFile({
  base: "source",
  afterWrite: { mode: "none", reason: "Clawdi runtime convergence owns service reconciliation" },
  writeOptions: { allowConfigSizeDrop: true, explicitSetPaths, unsetPaths },
  mutate: (draft) => applyMergePatch(draft, patch),
});
`;
function applyOpenClawHostedProviderPatch(
	patch: OpenClawHostedProviderPatch,
	context: OpenClawHostedContext,
	workspaceRoot: string,
): void {
	const sdkPath = context.requireSdkExport("configMutation");
	enforceRuntimeUserOwnership(runtimeUserDirectoryOwnership(context.home));
	runRuntimeUserCommand(
		"node",
		["--input-type=module", "--eval", OPENCLAW_CONFIG_MUTATION_HELPER, sdkPath],
		patch.content,
		context.home,
		workspaceRoot,
	);
}
export function buildOpenClawHostedProviderPatch(
	projectionInput: HostedAiProviderProjectionInput | null,
	previousProviderIds: readonly string[],
): OpenClawHostedProviderPatch {
	if (!projectionInput) {
		const deletedProviderIds = staleProviderIds(new Set(previousProviderIds), new Set());
		return {
			apply: deletedProviderIds.length > 0,
			content: `${JSON.stringify(openClawProviderDeletePatch(deletedProviderIds), null, 2)}\n`,
			providerIds: [],
		};
	}
	const projection = buildAgentTargetProjection(
		"openclaw",
		projectionInput.catalog,
		projectionInput.primaryModel,
	);
	const file = projection.files.find((entry) => entry.path.endsWith(".openclaw.json"));
	if (!file) throw new Error("OpenClaw projection did not include a config patch JSON file.");
	const providerIds = [...providerIdsFromPatch("openclaw", file.content)].sort();
	const deletedProviderIds = staleProviderIds(new Set(previousProviderIds), new Set(providerIds));
	const providerPatchContent =
		providerIds.length > 0 ? withOpenClawProviderMode(file.content, "replace") : file.content;
	return {
		apply: true,
		content: mergeProviderDeletes("openclaw", providerPatchContent, deletedProviderIds),
		providerIds,
	};
}
type ProviderPatchRuntime = "hermes" | "openclaw";
function providerPatchRoot(
	runtime: ProviderPatchRuntime,
	content: string,
): Record<string, unknown> | null {
	if (runtime === "hermes" && !content.trim()) return null;
	return recordValue(runtime === "openclaw" ? JSON.parse(content) : parseYaml(content));
}
function providerPatchProviders(
	runtime: ProviderPatchRuntime,
	root: Record<string, unknown>,
): Record<string, unknown> | null {
	const container = runtime === "openclaw" ? recordValue(root.models) : root;
	return container ? recordValue(container.providers) : null;
}
function providerIdsFromPatch(runtime: ProviderPatchRuntime, content: string): Set<string> {
	const root = providerPatchRoot(runtime, content);
	const providers = root ? providerPatchProviders(runtime, root) : null;
	if (!providers) return new Set();
	return new Set(
		Object.entries(providers)
			.filter(([, value]) => value !== null)
			.map(([providerId]) => providerId),
	);
}
function withOpenClawProviderMode(patchContent: string, mode: "merge" | "replace"): string {
	const parsed = JSON.parse(patchContent) as unknown;
	const root = recordValue(parsed);
	if (!root) return patchContent;
	const patch = { ...root };
	const models = { ...(recordValue(patch.models) ?? {}), mode };
	patch.models = models;
	return `${JSON.stringify(patch, null, 2)}\n`;
}
function openClawProviderDeletePatch(
	deletedProviderIds: readonly string[],
): Record<string, unknown> {
	return {
		models: {
			mode: "merge",
			providers: Object.fromEntries(deletedProviderIds.map((providerId) => [providerId, null])),
		},
	};
}
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
	"discover_models",
	"transport",
	"api_mode",
	"key_env",
	"api_key",
	"type",
	"auth_type",
] as const;
function applyHermesProviderConfig(
	context: HermesConfigCommandContext,
	patch: Record<string, unknown>,
	deletedProviderIds: readonly string[],
): void {
	const patchModel = recordValue(patch.model) ?? {};
	const modelKeys = new Set<string>([...HERMES_DIRECT_MODEL_FIELDS, ...Object.keys(patchModel)]);
	for (const key of [...modelKeys].sort()) {
		const value = Object.hasOwn(patchModel, key) ? patchModel[key] : undefined;
		reconcileHermesConfigValue(context, `model.${key}`, value === null ? undefined : value);
	}
	if (!Object.hasOwn(patchModel, "provider") && deletedProviderIds.length > 0) {
		const currentProvider = getHermesResolvedConfigValue(context, "model.provider");
		if (currentProvider.exists && typeof currentProvider.value !== "string") {
			throw new Error("Hermes config field model.provider must be a string");
		}
		const managedSelectors = new Set(
			deletedProviderIds.flatMap((providerId) => [providerId, `custom:${providerId}`]),
		);
		if (currentProvider.exists && managedSelectors.has(currentProvider.value as string)) {
			reconcileHermesConfigValue(context, "model.provider", undefined);
			if (!Object.hasOwn(patchModel, "default")) {
				reconcileHermesConfigValue(context, "model.default", undefined);
			}
		}
	}

	const currentValue = getHermesRawConfigValue(context, "providers");
	if (currentValue.exists && !isPlainRecord(currentValue.value)) {
		throw new Error("Hermes config field providers must be an object");
	}
	const currentProviders: Record<string, unknown> =
		currentValue.exists && isPlainRecord(currentValue.value) ? currentValue.value : {};
	for (const [providerId, provider] of Object.entries(currentProviders)) {
		if (provider !== undefined && provider !== null && !isPlainRecord(provider)) {
			throw new Error(`Hermes provider ${providerId} must be an object`);
		}
	}
	const nextProviders: Record<string, unknown> = { ...currentProviders };
	for (const providerId of deletedProviderIds) delete nextProviders[providerId];

	const patchProviders = recordValue(patch.providers) ?? {};
	for (const [providerId, providerPatch] of Object.entries(patchProviders)) {
		if (providerPatch === null) {
			delete nextProviders[providerId];
			continue;
		}
		if (!isPlainRecord(providerPatch)) continue;
		const existingProvider = nextProviders[providerId];
		if (
			existingProvider !== undefined &&
			existingProvider !== null &&
			!isPlainRecord(existingProvider)
		) {
			throw new Error(`Hermes provider ${providerId} must be an object`);
		}
		const nextProvider: Record<string, unknown> = isPlainRecord(existingProvider)
			? { ...existingProvider }
			: {};
		for (const key of HERMES_GENERATED_PROVIDER_FIELDS) delete nextProvider[key];
		let wroteGeneratedField = false;
		for (const [key, value] of Object.entries(providerPatch)) {
			if (value === null) {
				delete nextProvider[key];
				continue;
			}
			nextProvider[key] = value;
			wroteGeneratedField = true;
		}
		const hasUserOwnedField = Object.keys(nextProvider).some(
			(key) => !(HERMES_GENERATED_PROVIDER_FIELDS as readonly string[]).includes(key),
		);
		if (wroteGeneratedField || hasUserOwnedField) nextProviders[providerId] = nextProvider;
		else delete nextProviders[providerId];
	}

	if (Object.keys(nextProviders).length === 0 && Object.keys(currentProviders).length === 0) return;
	reconcileHermesConfigValue(
		context,
		"providers",
		Object.keys(nextProviders).length > 0 ? nextProviders : undefined,
	);
}
function mergeProviderDeletes(
	runtime: ProviderPatchRuntime,
	patchContent: string,
	deletedProviderIds: readonly string[],
): string {
	if (deletedProviderIds.length === 0) return patchContent;
	const root = providerPatchRoot(runtime, patchContent);
	if (!root) return patchContent;
	const patch = { ...root };
	const container =
		runtime === "openclaw" ? { ...(recordValue(patch.models) ?? { mode: "merge" }) } : patch;
	const existingProviders = recordValue(container.providers);
	const providers = existingProviders ? { ...existingProviders } : {};
	for (const providerId of deletedProviderIds) {
		providers[providerId] = null;
	}
	container.providers = providers;
	if (runtime === "openclaw") patch.models = container;
	return runtime === "openclaw"
		? `${JSON.stringify(patch, null, 2)}\n`
		: `${stringifyYaml(patch).trimEnd()}\n`;
}
function staleProviderIds(
	previousProviderIds: Set<string>,
	activeProviderIds: Set<string>,
): string[] {
	return [...previousProviderIds]
		.filter((providerId) => !activeProviderIds.has(providerId))
		.sort((left, right) => left.localeCompare(right));
}
export function openClawGatewayHostedPatch(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	ownerBrowserBootstrapSupported: boolean,
): Record<string, unknown> | null {
	const allowedOrigins = openClawControlUiAllowedOrigins(manifest);
	const trustedProxies = openClawGatewayTrustedProxies(manifest);
	const gatewayToken = manifest.openclawGatewayAuth
		? runtimeSecretValue(secretValues ?? {}, manifest.openclawGatewayAuth.tokenRef)
		: null;
	const nativeAuth = manifest.openclawGatewayAuth;
	if (nativeAuth?.activation.enabled !== true) {
		throw new Error("OpenClaw native auth capability is unavailable");
	}
	if (manifest.openclawGatewayAuth && !gatewayToken) {
		throw new Error("OpenClaw native gateway token is unavailable");
	}
	if (allowedOrigins.length === 0 && !gatewayToken && !manifest.locale) return null;
	return {
		...(manifest.locale
			? {
					agents: {
						defaults: {
							userTimezone: manifest.locale.timezone,
						},
					},
				}
			: {}),
		gateway: {
			mode: "local",
			trustedProxies,
			...(gatewayToken || allowedOrigins.length > 0
				? {
						...(nativeAuth ? { port: 18789, bind: "lan" } : {}),
						...(gatewayToken
							? {
									auth: {
										mode: "token",
										token: gatewayToken,
									},
								}
							: {}),
						...(allowedOrigins.length > 0
							? {
									controlUi: {
										allowedOrigins,
										...(nativeAuth
											? {
													basePath: openClawControlUiBasePath(manifest),
													dangerouslyAllowHostHeaderOriginFallback: false,
													dangerouslyDisableDeviceAuth: ownerBrowserBootstrapSupported
														? null
														: true,
												}
											: {}),
									},
								}
							: {}),
					}
				: {}),
		},
	};
}
function jsonMergePatchIsApplied(current: unknown, patch: unknown): boolean {
	if (!isPlainRecord(patch)) return canonicalJsonEqual(current, patch);
	if (!isPlainRecord(current)) {
		if (current !== undefined) return false;
		// OpenClaw canonicalizes deletion-only patches by omitting their empty parents.
		return Object.values(patch).every(
			(value) =>
				value === undefined ||
				value === null ||
				(isPlainRecord(value) && jsonMergePatchIsApplied(undefined, value)),
		);
	}
	return Object.entries(patch).every(([key, value]) =>
		value === undefined
			? true
			: value === null
				? !Object.hasOwn(current, key)
				: jsonMergePatchIsApplied(current[key], value),
	);
}
export function openClawConfigPatchIsApplied(
	context: OpenClawHostedContext,
	patch: Record<string, unknown>,
): boolean {
	try {
		const current = JSON.parse(readFileSync(context.configPath, "utf-8")) as unknown;
		return jsonMergePatchIsApplied(current, patch);
	} catch {
		return false;
	}
}
function openClawControlUiBasePath(manifest: RuntimeManifest): string {
	const system = manifest.projection?.system;
	if (!isPlainRecord(system)) return "/";
	const value = system.openclawControlUiBasePath;
	if (typeof value !== "string" || !value.startsWith("/")) return "/";
	return value === "/" ? "/" : value.replace(/\/$/, "");
}
function applyOpenClawGatewayHostedProjection(
	command: string,
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	context: OpenClawHostedContext,
	workspaceRoot: string,
	ownerBrowserBootstrapSupported: boolean,
): void {
	const patch = openClawGatewayHostedPatch(manifest, secretValues, ownerBrowserBootstrapSupported);
	if (!patch || openClawConfigPatchIsApplied(context, patch)) return;
	runRuntimeUserCommand(
		command,
		["config", "patch", "--stdin"],
		`${JSON.stringify(patch, null, 2)}\n`,
		context.home,
		workspaceRoot,
	);
}
function openClawControlUiAllowedOrigins(manifest: RuntimeManifest): string[] {
	const system = manifest.projection?.system;
	if (!isPlainRecord(system)) return [];
	const raw = system.openclawControlUiAllowedOrigins;
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const origins: string[] = [];
	for (const value of raw) {
		if (typeof value !== "string") continue;
		const origin = value.trim();
		if (!origin || seen.has(origin)) continue;
		seen.add(origin);
		origins.push(origin);
	}
	return origins;
}
function openClawGatewayTrustedProxies(manifest: RuntimeManifest): string[] {
	const system = manifest.projection?.system;
	if (!isPlainRecord(system)) return [];
	const raw = system.openclawGatewayTrustedProxies;
	return Array.isArray(raw)
		? raw.filter((value): value is string => typeof value === "string")
		: [];
}
