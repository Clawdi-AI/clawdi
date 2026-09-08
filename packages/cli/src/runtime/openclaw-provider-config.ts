import { readFileSync } from "node:fs";
import type { OpenClawHostedContext } from "./hosted-openclaw-context";
import type { RuntimeManifest } from "./manifest-contract";
import { runtimeFileCurrentRevision } from "./manifest-install";
import { canonicalJsonEqual, isPlainRecord, recordValue } from "./manifest-shared";
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
const sourceConfig = snapshot?.sourceConfig;
const sourceAgents = isRecord(sourceConfig) ? sourceConfig.agents : undefined;
const sourceDefaults = isRecord(sourceAgents) ? sourceAgents.defaults : undefined;
const sourceMemory = isRecord(sourceConfig) ? sourceConfig.memory : undefined;
const patchAgents = patch.agents;
const patchDefaults = isRecord(patchAgents) ? patchAgents.defaults : undefined;
const patchMemory = patch.memory;
const repairsUnsupportedMemorySearch =
  (isRecord(sourceDefaults) &&
    Object.hasOwn(sourceDefaults, "memorySearch") &&
    isRecord(patchDefaults) &&
    patchDefaults.memorySearch === null) ||
  (isRecord(sourceMemory) &&
    Object.hasOwn(sourceMemory, "search") &&
    isRecord(patchMemory) &&
    patchMemory.search === null &&
    isRecord(patchDefaults?.memorySearch));
if (
  !snapshot ||
  !isRecord(sourceConfig) ||
  (snapshot.valid !== true && !repairsUnsupportedMemorySearch)
) {
  throw new Error("OpenClaw config snapshot is unavailable for provider projection");
}
const projected = structuredClone(sourceConfig);
applyMergePatch(projected, patch);
if (isDeepStrictEqual(projected, sourceConfig)) process.exit(0);
explicitSetPaths.length = 0;
unsetPaths.length = 0;
await sdk.mutateConfigFile({
  base: "source",
  afterWrite: { mode: "none", reason: "Clawdi runtime convergence owns service reconciliation" },
  writeOptions: { allowConfigSizeDrop: true, explicitSetPaths, unsetPaths },
  mutate: (draft) => applyMergePatch(draft, patch),
});
`;
export function applyOpenClawHostedProviderPatch(
	patch: OpenClawHostedProviderPatch,
	commandPath: string,
	context: OpenClawHostedContext,
	workspaceRoot: string,
	providerRevision: string,
): void {
	const sdkPath = context.requireSdkExport("configMutation");
	const content = adaptOpenClawMemorySearchPatch(
		patch.content,
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
	if (openClawProviderPatchRevisions.get(context.configPath) === patchRevision) {
		const expected = recordValue(JSON.parse(content) as unknown);
		if (!expected) throw new Error("OpenClaw provider projection patch must be an object");
		if (openClawConfigPatchIsApplied(context, expected, patch.providerIds)) return;
	}
	runRuntimeUserCommand(
		"node",
		["--input-type=module", "--eval", OPENCLAW_CONFIG_MUTATION_HELPER, sdkPath],
		content,
		context.home,
		workspaceRoot,
	);
	openClawProviderPatchRevisions.set(context.configPath, patchRevision);
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
