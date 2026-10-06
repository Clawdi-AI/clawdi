import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import type { RuntimeManifest } from "./manifest-contract";
import { runtimeFileCurrentRevision } from "./manifest-install";
import { canonicalJsonEqual, isPlainRecord, recordValue } from "./manifest-shared";
import { readPlainOpenClawConfig } from "./openclaw-config";
import { OPENCLAW_CONFIG_MUTATION_HELPER } from "./openclaw-config-mutation-script";
import {
	openClawFileSecretEnvironmentKeys,
	projectOpenClawProviderFileSecrets,
} from "./openclaw-file-secrets";
import { openClawHotApplyEnabled } from "./openclaw-warm-gateway";
import {
	openClawStepIdentity,
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

export interface OpenClawConfigTransaction {
	operations: Array<{
		kind: "provider" | "channels";
		input: Record<string, unknown>;
		exactProviderIds?: readonly string[];
	}>;
	afterCommit: Array<() => void>;
	environment: Record<string, string>;
	fileSecretKeys: Set<string>;
}

export function beginOpenClawConfigTransaction(
	context: OpenClawHostedContext,
	environment: Record<string, string>,
): void {
	if (context.configMutationState.transaction)
		throw new Error("OpenClaw config transaction is already active");
	context.configMutationState.transaction = {
		operations: [],
		afterCommit: [],
		environment,
		fileSecretKeys: openClawFileSecretEnvironmentKeys(context.home),
	};
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
				transaction.fileSecretKeys,
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
		? projectOpenClawProviderFileSecrets(
				patch.content,
				transaction.environment,
				context.home,
				transaction.fileSecretKeys,
			)
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
		implementation: openClawStepIdentity(context.home, [OPENCLAW_CONFIG_MUTATION_HELPER]),
		sdk: runtimeFileCurrentRevision(sdkPath),
	});
	// Across processes the patch content and SDK decide the result; the live config
	// is still re-read below.
	const persistedKey = `openclaw.providerPatch:${context.configPath}`;
	const persistedRevision = runtimeImpactRevision({
		content,
		implementation: openClawStepIdentity(context.home, [OPENCLAW_CONFIG_MUTATION_HELPER]),
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
				transaction.fileSecretKeys,
			),
		);
	if (
		openClawHotApplyEnabled() &&
		openClawChannelPatchIsNoop(patch, previousChannels, context.configPath)
	)
		return;
	const sdkPath = context.requireSdkExport("configMutation");
	const input = JSON.stringify({ patch, previousChannels, availableChannelEnv });
	// Skip only when this exact input already produced the current config bytes.
	const persistedKey = `openclaw.channelPatch:${context.configPath}`;
	const inputRevision = runtimeImpactRevision({
		input,
		implementation: openClawStepIdentity(context.home, [OPENCLAW_CONFIG_MUTATION_HELPER]),
		sdk: runtimeFileCurrentRevision(sdkPath),
	});
	const appliedState = () =>
		`${inputRevision}\n${runtimeFilesContentRevision([context.configPath])}`;
	const before = appliedState();
	const record = () => {
		if (readPlainOpenClawConfig(context.configPath) && appliedState() === before)
			recordPersistedStepRevision(persistedKey, before);
	};
	if (readPlainOpenClawConfig(context.configPath) && persistedStepRevision(persistedKey) === before)
		return;
	if (transaction) {
		transaction.operations.push({ kind: "channels", input: JSON.parse(input) });
		transaction.afterCommit.push(record);
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
	record();
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
	const current = readPlainOpenClawConfig(configPath);
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
	const stateRevision = () =>
		[
			openClawStepIdentity(home, ["config schema", jsonSchemaHasPropertyPath.toString()]),
			runtimeFileCurrentRevision(commandPath),
			runtimeFileCurrentRevision(sdkPath),
		].join("\0");
	const revision = stateRevision();
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
	if (stateRevision() === revision) {
		openClawMemorySearchLayouts.set(commandPath, { revision, layout });
		recordPersistedStepRevision(persistedKey, `${revision}\n${layout}`);
	}
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
		const current = readPlainOpenClawConfig(context.configPath);
		if (!current) return false;
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
