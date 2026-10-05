import { readFileSync } from "node:fs";
import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import type { RuntimeManifest } from "./manifest-contract";
import { runtimeFileCurrentRevision } from "./manifest-install";
import { canonicalJsonEqual, isPlainRecord, recordValue } from "./manifest-shared";
import { projectOpenClawProviderFileSecrets } from "./openclaw-file-secrets";
import { openClawHotApplyEnabled } from "./openclaw-warm-gateway";
import {
	persistedStepRevision,
	recordPersistedStepRevision,
	runtimeFilesContentRevision,
} from "./persisted-step-revisions";
import { runtimeImpactRevision } from "./runtime-impact-revision";
import { runRuntimeUserCommand, spawnRuntimeUserCommand } from "./runtime-user-command";
import { runtimeSecretValue } from "./secret-values";

const OPENCLAW_SCHEMA_PROBE_TIMEOUT_MS = 15_000;
const OPENCLAW_SCHEMA_PROBE_MAX_BYTES = 16 * 1024 * 1024;
const openClawProviderPatchRevisions = new Map<string, string>();
const openClawMemorySearchLayouts = new Map<
	string,
	{ revision: string; layout: OpenClawMemorySearchLayout }
>();

type OpenClawMemorySearchLayout = "agents-defaults" | "top-level";

export interface OpenClawHostedProviderPatch {
	apply: boolean;
	content: string;
	providerIds: string[];
}
const OPENCLAW_CONFIG_MUTATION_HELPER = `
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Warm-up seeds this runtime-user cache. Node validates source/version identity;
// unavailable caching is harmless and never replaces native config validation.
nodeModule.enableCompileCache?.(join(homedir(), ".cache", "clawdi", "openclaw-config-writer"));
const sdk = await import(pathToFileURL(process.argv[1]).href);
if (
  typeof sdk.readConfigFileSnapshotForWrite !== "function" ||
  typeof sdk.mutateConfigFile !== "function"
) {
  throw new Error("required public config-mutation export is missing");
}
const input = JSON.parse(readFileSync(0, "utf8"));
const explicitSetPaths = [];
const unsetPaths = [];
const makeMutator = (operation) => {
const input = operation.input;
const channelMutation = operation.kind === "channels";
const patch = channelMutation ? input.patch : input;
const exactProviderIds = operation.exactProviderIds ?? null;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
if (!isRecord(patch)) throw new Error("OpenClaw provider patch must be an object");
const blockedKeys = new Set(["__proto__", "constructor", "prototype"]);
const applyMergePatch = (target, source, path = []) => {
  for (const [key, value] of Object.entries(source)) {
    if (blockedKeys.has(key)) throw new Error("OpenClaw provider patch contains a blocked key");
    const nextPath = [...path, key];
    if (value === null) {
      delete target[key];
      unsetPaths.push(nextPath);
    } else if (path.length === 2 && path[0] === "models" && path[1] === "providers" &&
      (exactProviderIds === null || exactProviderIds.includes(key))) {
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
const applyChannelPatch = (draft) => {
  const desired = structuredClone(patch);
  const channels = {};
  const logicalCredential = (ref) => ref?.source === "file" && ref.provider === "clawdi-runtime" &&
    typeof ref.id === "string" && ref.id.startsWith("/") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.id.slice(1))
    ? { source: "env", provider: "default", id: ref.id.slice(1) } : ref;
  for (const provider of ["telegram", "discord", "whatsapp"]) {
    const selected = desired.channels?.[provider];
    const selectedAccounts = selected?.accounts ?? {};
    const current = draft.channels?.[provider];
    const currentAccounts = current?.accounts ?? {};
    const previous = input.previousChannels?.[provider];
    const previousAccounts = previous?.accounts ?? {};
    const credential = provider === "telegram" ? "botToken" : provider === "discord" ? "token" : "authDir";
    const matches = (actual, owned) => isRecord(actual) && isRecord(owned) &&
      Object.hasOwn(owned, credential) && isDeepStrictEqual(logicalCredential(actual[credential]), logicalCredential(owned[credential]));
    const accounts = {};
    for (const [id, owned] of Object.entries(previousAccounts)) {
      if (!Object.hasOwn(selectedAccounts, id) && matches(currentAccounts[id], owned)) accounts[id] = null;
    }
    for (const [id, account] of Object.entries(selectedAccounts)) {
      if (!isRecord(account)) throw new Error("Invalid managed channel account");
      if (!Object.hasOwn(currentAccounts, id)) accounts[id] = account;
      else {
        if (!matches(currentAccounts[id], account) && !matches(currentAccounts[id], previousAccounts[id])) {
          throw new Error("Native channel account ownership changed; refusing managed update");
        }
        accounts[id] = { enabled: account.enabled, [credential]: account[credential] };
      }
    }
    if (Object.keys(accounts).length === 0) continue;
    const channel = { ...(selected ? { enabled: true } : {}), accounts };
    if (!current && selected?.defaultAccount !== undefined) channel.defaultAccount = selected.defaultAccount;
    else if (typeof current?.defaultAccount === "string" && accounts[current.defaultAccount] === null &&
        previous?.defaultAccount === current.defaultAccount) channel.defaultAccount = selected?.defaultAccount ?? null;
    channels[provider] = channel;
  }
  desired.channels = channels;
  applyMergePatch(draft, desired);
  // A retained entry is not delete authority. Reject missing managed references instead of
  // committing an invalid configuration after its environment has been withdrawn.
  for (const provider of ["telegram", "discord"]) {
    const channel = draft.channels?.[provider];
    const credential = provider === "telegram" ? "botToken" : "token";
    for (const account of [channel, ...Object.values(channel?.accounts ?? {})]) {
      const ref = account?.[credential];
      const logical = logicalCredential(ref);
      if (logical?.source === "env" && logical.provider === "default" && typeof logical.id === "string" &&
          logical.id.startsWith("CLAWDI_CHANNEL_") && logical.id.endsWith("_AGENT_TOKEN") &&
          !input.availableChannelEnv.includes(logical.id)) {
        throw new Error("Retained channel references a withdrawn managed credential; ownership repair required");
      }
    }
  }
};
const mergeNativeOptions = (legacy, current) => {
  if (!isRecord(legacy) || !isRecord(current)) return structuredClone(current);
  const merged = structuredClone(legacy);
  for (const [key, value] of Object.entries(current)) {
    if (blockedKeys.has(key)) throw new Error("Invalid native memory option");
    merged[key] = Object.hasOwn(merged, key) ? mergeNativeOptions(merged[key], value) : structuredClone(value);
  }
  return merged;
};
const applyProviderPatch = (draft) => {
  const desired = structuredClone(patch);
  const defaults = isRecord(draft.agents) ? draft.agents.defaults : undefined;
  const legacy = isRecord(defaults) ? defaults.memorySearch : undefined;
  const current = isRecord(draft.memory) ? draft.memory.search : undefined;
  const authored = mergeNativeOptions(isRecord(legacy) ? legacy : {}, isRecord(current) ? current : {});
  const desiredDefaults = isRecord(desired.agents) ? desired.agents.defaults : undefined;
  const searchContainer = isRecord(desired.memory?.search) ? desired.memory : desiredDefaults;
  const searchKey = isRecord(desired.memory?.search) ? "search" : "memorySearch";
  // A hosted embedding default does not own native selection. Read inside the native mutation
  // as well as the preview, so a concurrent user edit is not restored from an earlier snapshot.
  if (isRecord(searchContainer?.[searchKey])) {
    searchContainer[searchKey] = Object.hasOwn(authored, "provider") || Object.hasOwn(authored, "model")
      ? authored : { ...authored, ...searchContainer[searchKey] };
  }
  applyMergePatch(draft, desired);
};
return { patch, channelMutation, mutate: channelMutation ? applyChannelPatch : applyProviderPatch };
};
const isRootRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const operations = process.argv[2] === "batch" ? input.operations : [{
  kind: process.argv[2] === "channels" ? "channels" : "provider", input,
}];
const mutators = operations.map(makeMutator);
const configRead = await sdk.readConfigFileSnapshotForWrite({ skipPluginValidation: true });
const snapshot = configRead?.snapshot;
const sourceConfig = snapshot?.sourceConfig;
const sourceDefaults = sourceConfig?.agents?.defaults;
const repairsUnsupportedMemorySearch = mutators.some(({ patch }) =>
  (Object.hasOwn(sourceDefaults ?? {}, "memorySearch") && patch.agents?.defaults?.memorySearch === null) ||
  (Object.hasOwn(sourceConfig?.memory ?? {}, "search") && patch.memory?.search === null &&
    typeof patch.agents?.defaults?.memorySearch === "object"));
if (!snapshot || !isRootRecord(sourceConfig) ||
    (snapshot.valid !== true && !repairsUnsupportedMemorySearch && !mutators.some((op) => op.channelMutation))) {
  throw new Error("OpenClaw config snapshot is unavailable for projection");
}
const mutate = (draft) => { for (const op of mutators) op.mutate(draft); };
const projected = structuredClone(sourceConfig);
mutate(projected);
if (snapshot.valid === true && isDeepStrictEqual(projected, sourceConfig)) process.exit(0);
explicitSetPaths.length = 0;
unsetPaths.length = 0;
await sdk.mutateConfigFile({
  base: "source",
  afterWrite: process.argv.includes("hot-apply") ? { mode: "auto" } : { mode: "none", reason: "Clawdi runtime convergence owns service reconciliation" },
  writeOptions: { allowConfigSizeDrop: true, explicitSetPaths, unsetPaths },
  mutate,
});
`;
export interface OpenClawConfigTransaction {
	operations: Array<{
		kind: "provider" | "channels";
		input: Record<string, unknown>;
		exactProviderIds?: readonly string[];
	}>;
	afterCommit: Array<() => void>;
	environment: Record<string, string>;
}

export function beginOpenClawConfigTransaction(
	context: OpenClawHostedContext,
	environment: Record<string, string>,
): void {
	if (context.configMutationState.transaction)
		throw new Error("OpenClaw config transaction is already active");
	context.configMutationState.transaction = { operations: [], afterCommit: [], environment };
}

export function commitOpenClawConfigTransaction(
	context: OpenClawHostedContext,
	workspaceRoot: string,
): void {
	const transaction = context.configMutationState.transaction;
	if (!transaction) return;
	try {
		if (transaction.operations.length > 0) {
			runRuntimeUserCommand(
				"node",
				[
					"--input-type=module",
					"--eval",
					OPENCLAW_CONFIG_MUTATION_HELPER,
					context.requireSdkExport("configMutation"),
					"batch",
					"hot-apply",
				],
				JSON.stringify({ operations: transaction.operations }),
				context.home,
				workspaceRoot,
			);
		}
		for (const record of transaction.afterCommit) record();
	} finally {
		context.configMutationState.transaction = null;
	}
}

/** Merge owned native fields, preserving unrelated provider fields. */
export function applyOpenClawContextMergePatch(
	context: OpenClawHostedContext,
	patch: Record<string, unknown>,
	workspaceRoot: string,
): void {
	const transaction = context.configMutationState.transaction;
	if (transaction) {
		const input = JSON.parse(
			projectOpenClawProviderFileSecrets(
				JSON.stringify(patch),
				transaction.environment,
				context.home,
			),
		);
		transaction.operations.push({ kind: "provider", input, exactProviderIds: [] });
		return;
	}
	applyOpenClawConfigMergePatch(
		context.requireSdkExport("configMutation"),
		JSON.stringify(patch),
		context.home,
		workspaceRoot,
	);
}

export function applyOpenClawHostedProviderPatch(
	patch: OpenClawHostedProviderPatch,
	commandPath: string,
	context: OpenClawHostedContext,
	workspaceRoot: string,
	providerRevision: string,
): void {
	const sdkPath = context.requireSdkExport("configMutation");
	const transaction = context.configMutationState.transaction;
	const desiredContent = transaction
		? projectOpenClawProviderFileSecrets(patch.content, transaction.environment, context.home)
		: patch.content;
	const content = adaptOpenClawMemorySearchPatch(
		desiredContent,
		commandPath,
		context.home,
		workspaceRoot,
		sdkPath,
	);
	const patchRevision = runtimeImpactRevision({
		providerRevision,
		content,
		sdk: runtimeFileCurrentRevision(sdkPath),
	});
	// Across processes the patch content and SDK decide the result; the live config
	// is still re-read below.
	const persistedKey = `openclaw.providerPatch:${context.configPath}`;
	const persistedRevision = runtimeImpactRevision({
		content,
		sdk: runtimeFileCurrentRevision(sdkPath),
	});
	if (
		openClawProviderPatchRevisions.get(context.configPath) === patchRevision ||
		persistedStepRevision(persistedKey) === persistedRevision
	) {
		// The live config is re-read: a remembered revision alone never skips.
		const expected = recordValue(JSON.parse(content) as unknown);
		if (!expected) throw new Error("OpenClaw provider projection patch must be an object");
		if (openClawConfigPatchIsApplied(context, expected, patch.providerIds)) return;
	}
	if (transaction) {
		transaction.operations.push({
			kind: "provider",
			input: JSON.parse(content),
			exactProviderIds: patch.providerIds,
		});
		transaction.afterCommit.push(() => {
			openClawProviderPatchRevisions.set(context.configPath, patchRevision);
			recordPersistedStepRevision(persistedKey, persistedRevision);
		});
		return;
	}
	runRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_CONFIG_MUTATION_HELPER,
			sdkPath,
			...(openClawHotApplyEnabled() ? ["hot-apply"] : []),
		],
		content,
		context.home,
		workspaceRoot,
	);
	openClawProviderPatchRevisions.set(context.configPath, patchRevision);
	recordPersistedStepRevision(persistedKey, persistedRevision);
}

/** Apply one JSON merge patch through the official config writer. */
export function applyOpenClawConfigMergePatch(
	sdkPath: string,
	content: string,
	home: string,
	workspaceRoot: string,
): void {
	runRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_CONFIG_MUTATION_HELPER,
			sdkPath,
			...(openClawHotApplyEnabled() ? ["hot-apply"] : []),
		],
		content,
		home,
		workspaceRoot,
	);
}

export function applyOpenClawHostedChannelPatch(
	patch: Record<string, unknown>,
	previousChannels: Record<string, unknown> | null,
	availableChannelEnv: string[],
	context: OpenClawHostedContext,
	workspaceRoot: string,
): void {
	const transaction = context.configMutationState.transaction;
	if (transaction)
		patch = JSON.parse(
			projectOpenClawProviderFileSecrets(
				JSON.stringify(patch),
				transaction.environment,
				context.home,
			),
		);
	if (openClawChannelPatchIsNoop(patch, previousChannels, context.configPath)) return;
	const sdkPath = context.requireSdkExport("configMutation");
	const input = JSON.stringify({ patch, previousChannels, availableChannelEnv });
	// Skip only when this exact input already produced the current config bytes.
	const persistedKey = `openclaw.channelPatch:${context.configPath}`;
	const inputRevision = runtimeImpactRevision({ input, sdk: runtimeFileCurrentRevision(sdkPath) });
	const appliedState = () =>
		`${inputRevision}\n${runtimeFilesContentRevision([context.configPath])}`;
	if (persistedStepRevision(persistedKey) === appliedState()) return;
	if (transaction) {
		transaction.operations.push({ kind: "channels", input: JSON.parse(input) });
		transaction.afterCommit.push(() => recordPersistedStepRevision(persistedKey, appliedState()));
		return;
	}
	// No custom IO: the official writer owns its cross-process lock, snapshot and commit checks.
	runRuntimeUserCommand(
		"node",
		[
			"--input-type=module",
			"--eval",
			OPENCLAW_CONFIG_MUTATION_HELPER,
			sdkPath,
			"channels",
			...(openClawHotApplyEnabled() ? ["hot-apply"] : []),
		],
		input,
		context.home,
		workspaceRoot,
	);
	recordPersistedStepRevision(persistedKey, appliedState());
}

const OPENCLAW_MANAGED_CHANNEL_PROVIDERS = ["telegram", "discord", "whatsapp"] as const;

function hasManagedChannelAccounts(channels: unknown): boolean {
	const record = recordValue(channels);
	return OPENCLAW_MANAGED_CHANNEL_PROVIDERS.some(
		(provider) =>
			Object.keys(recordValue(recordValue(record?.[provider])?.accounts) ?? {}).length > 0,
	);
}

/** Strict merge-patch no-op: an empty object still requires an existing object. */
function jsonMergePatchIsNoop(current: unknown, patch: unknown): boolean {
	if (!isPlainRecord(patch)) return canonicalJsonEqual(current, patch);
	if (!isPlainRecord(current)) return false;
	return Object.entries(patch).every(([key, value]) =>
		value === null ? !Object.hasOwn(current, key) : jsonMergePatchIsNoop(current[key], value),
	);
}

/**
 * Without selected or previously owned accounts, the channel helper only ensures
 * its containers exist. Decide that case from the plain config file so an
 * unchanged empty projection does not start the SDK; anything else (managed
 * accounts, native managed-provider entries, includes) runs the helper.
 */
function openClawChannelPatchIsNoop(
	patch: Record<string, unknown>,
	previousChannels: Record<string, unknown> | null,
	configPath: string,
): boolean {
	if (hasManagedChannelAccounts(patch.channels) || hasManagedChannelAccounts(previousChannels)) {
		return false;
	}
	let current: Record<string, unknown> | null;
	try {
		const text = readFileSync(configPath, "utf-8");
		if (text.includes("$include")) return false;
		current = recordValue(JSON.parse(text) as unknown);
	} catch {
		return false;
	}
	const currentChannels = recordValue(current?.channels);
	if (
		!currentChannels ||
		OPENCLAW_MANAGED_CHANNEL_PROVIDERS.some((provider) => Object.hasOwn(currentChannels, provider))
	) {
		return false;
	}
	const desired = recordValue(JSON.parse(JSON.stringify({ ...patch, channels: {} })) as unknown);
	return jsonMergePatchIsNoop(current, desired);
}

function adaptOpenClawMemorySearchPatch(
	content: string,
	commandPath: string,
	home: string,
	workspaceRoot: string,
	sdkPath: string,
): string {
	const root = recordValue(JSON.parse(content) as unknown);
	if (!root) throw new Error("OpenClaw provider projection patch must be an object");
	const memory = recordValue(root.memory);
	if (!memory || !Object.hasOwn(memory, "search")) return content;
	const search = memory.search;
	if (openClawMemorySearchLayout(commandPath, home, workspaceRoot, sdkPath) === "top-level") {
		return content;
	}

	const patch = { ...root };
	const agents = { ...(recordValue(patch.agents) ?? {}) };
	const defaults = { ...(recordValue(agents.defaults) ?? {}) };
	defaults.memorySearch = search;
	agents.defaults = defaults;
	patch.agents = agents;
	patch.memory = { ...memory, search: null };
	return `${JSON.stringify(patch, null, 2)}\n`;
}

/** Anonymous preinstallation: record the version-only schema layout probe. */
export function seedOpenClawMemorySearchLayout(
	commandPath: string,
	home: string,
	sdkPath: string,
): void {
	openClawMemorySearchLayout(commandPath, home, home, sdkPath);
}

function openClawMemorySearchLayout(
	commandPath: string,
	home: string,
	workspaceRoot: string,
	sdkPath: string,
): OpenClawMemorySearchLayout {
	const revision = [
		runtimeFileCurrentRevision(commandPath),
		runtimeFileCurrentRevision(sdkPath),
	].join("\0");
	const cached = openClawMemorySearchLayouts.get(commandPath);
	if (cached?.revision === revision) return cached.layout;
	// Version-only: the installed command and SDK files decide the schema layout.
	const persistedKey = `openclaw.memorySearchLayout:${commandPath}`;
	for (const layout of ["top-level", "agents-defaults"] as const) {
		if (persistedStepRevision(persistedKey) === `${revision}\n${layout}`) {
			openClawMemorySearchLayouts.set(commandPath, { revision, layout });
			return layout;
		}
	}

	const result = spawnRuntimeUserCommand(commandPath, ["config", "schema"], home, workspaceRoot, {
		timeoutMs: OPENCLAW_SCHEMA_PROBE_TIMEOUT_MS,
		maxBufferBytes: OPENCLAW_SCHEMA_PROBE_MAX_BYTES,
	});
	if (result.status !== 0) {
		throw new Error("installed OpenClaw config schema is unavailable");
	}
	let schema: unknown;
	try {
		schema = JSON.parse(String(result.stdout));
	} catch {
		throw new Error("installed OpenClaw config schema is malformed");
	}
	const topLevel = jsonSchemaHasPropertyPath(schema, ["memory", "search"]);
	const agentsDefaults = jsonSchemaHasPropertyPath(schema, ["agents", "defaults", "memorySearch"]);
	if (topLevel === agentsDefaults) {
		throw new Error("installed OpenClaw memory search schema is unsupported");
	}
	const layout: OpenClawMemorySearchLayout = topLevel ? "top-level" : "agents-defaults";
	openClawMemorySearchLayouts.set(commandPath, { revision, layout });
	recordPersistedStepRevision(persistedKey, `${revision}\n${layout}`);
	return layout;
}

function jsonSchemaHasPropertyPath(schema: unknown, path: readonly string[]): boolean {
	let current = recordValue(schema);
	for (const segment of path) {
		const properties = current ? recordValue(current.properties) : null;
		current = properties ? recordValue(properties[segment]) : null;
		if (!current) return false;
	}
	return true;
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
			...(trustedProxies.length > 0 ? { trustedProxies } : {}),
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
	exactProviderIds: readonly string[] = [],
): boolean {
	try {
		const current = JSON.parse(readFileSync(context.configPath, "utf-8")) as unknown;
		if (!jsonMergePatchIsApplied(current, patch)) return false;
		const currentProviders = recordValue(recordValue(recordValue(current)?.models)?.providers);
		const desiredProviders = recordValue(recordValue(patch.models)?.providers);
		return exactProviderIds.every((id) =>
			canonicalJsonEqual(currentProviders?.[id], desiredProviders?.[id]),
		);
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
export function applyOpenClawGatewayHostedProjection(
	command: string,
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
	context: OpenClawHostedContext,
	workspaceRoot: string,
	ownerBrowserBootstrapSupported: boolean,
	environment: Record<string, string> = {},
): void {
	const patch = openClawGatewayHostedPatch(manifest, secretValues, ownerBrowserBootstrapSupported);
	if (!patch || openClawConfigPatchIsApplied(context, patch)) return;
	if (context.configMutationState.transaction) {
		applyOpenClawContextMergePatch(context, patch, workspaceRoot);
		return;
	}
	runRuntimeUserCommand(
		command,
		["config", "patch", "--stdin"],
		`${JSON.stringify(patch, null, 2)}\n`,
		context.home,
		workspaceRoot,
		{ environment },
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
