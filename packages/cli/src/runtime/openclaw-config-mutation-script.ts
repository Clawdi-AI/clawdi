/** Official native mutation with locking, CAS, validation and reload policy. */
export const OPENCLAW_CONFIG_MUTATION_HELPER = `import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const mutationProfileEnabled = process.env.CLAWDI_RUNTIME_PROFILE === "1";
const emitMutationSpan = (label, startedAt, started) => {
  if (mutationProfileEnabled) console.error("CLAWDI_RUNTIME_SPAN " + JSON.stringify({
    label, pid: process.pid, startedAt, durationMs: Math.round((performance.now()-started)*100)/100,
  }));
};
const profileMutation = async (label, run) => {
  const startedAt = Date.now(), started = performance.now();
  try { return await run(); } finally { emitMutationSpan(label, startedAt, started); }
};
const sdk = await profileMutation("writer.import-sdk", () => import(pathToFileURL(process.argv[1]).href));
async function mutateOpenClawConfig(sdk, input, kind, hotApply) {
  if (typeof sdk.readConfigFileSnapshotForWrite !== "function" || typeof sdk.mutateConfigFile !== "function")
    throw new Error("required public config-mutation export is missing");
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
const operations = kind === "batch" ? input.operations : [{
  kind: kind === "channels" ? "channels" : "provider", input,
}];
const mutators = operations.map(makeMutator);
const configRead = await profileMutation("writer.read-preview", () => sdk.readConfigFileSnapshotForWrite({ skipPluginValidation: true }));
const snapshot = configRead?.snapshot;
const sourceConfig = snapshot?.sourceConfig;
const sourceAgents = isRootRecord(sourceConfig) ? sourceConfig.agents : undefined;
const sourceDefaults = isRootRecord(sourceAgents) ? sourceAgents.defaults : undefined;
const sourceMemory = isRootRecord(sourceConfig) ? sourceConfig.memory : undefined;
const repairsUnsupportedMemorySearch = mutators.some(({ patch }) => {
  const patchDefaults = isRootRecord(patch.agents) ? patch.agents.defaults : undefined;
  return (isRootRecord(sourceDefaults) && Object.hasOwn(sourceDefaults, "memorySearch") &&
    isRootRecord(patchDefaults) && patchDefaults.memorySearch === null) ||
    (isRootRecord(sourceMemory) && Object.hasOwn(sourceMemory, "search") &&
      isRootRecord(patch.memory) && patch.memory.search === null &&
      isRootRecord(patchDefaults?.memorySearch));
});
if (!snapshot || !isRootRecord(sourceConfig) ||
    (snapshot.valid !== true && !repairsUnsupportedMemorySearch && !mutators.some((op) => op.channelMutation))) {
  throw new Error("OpenClaw config snapshot is unavailable for provider projection");
}
const mutate = (draft) => { for (const op of mutators) op.mutate(draft); };
const projected = structuredClone(sourceConfig);
mutate(projected);
if (snapshot.valid === true && isDeepStrictEqual(projected, sourceConfig)) return;
explicitSetPaths.length = 0;
unsetPaths.length = 0;
await profileMutation("writer.mutate", () => sdk.mutateConfigFile({
  base: "source",
  afterWrite: hotApply ? { mode: "auto" } : { mode: "none", reason: "Clawdi runtime convergence owns service reconciliation" },
  writeOptions: { allowConfigSizeDrop: true, explicitSetPaths, unsetPaths },
  mutate,
}));

}
await mutateOpenClawConfig(sdk, JSON.parse(readFileSync(0, "utf8")), process.argv[2], process.argv.includes("hot-apply"));
`;
