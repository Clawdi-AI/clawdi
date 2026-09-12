import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeFakeOpenClawConfigMutationSdk(
	home: string,
	options: {
		importLog?: string;
		initialConfig?: Record<string, unknown>;
		beforeMutation?: Record<string, unknown>;
	} = {},
): string {
	const { importLog, initialConfig = {} } = options;
	const packageRoot = join(home, ".local", "lib", "node_modules", "openclaw");
	const configPath = join(home, ".openclaw", "openclaw.json");
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "openclaw",
			type: "module",
			exports: {
				"./plugin-sdk/config-mutation": "./config-mutation.mjs",
				"./plugin-sdk/device-bootstrap": "./device-bootstrap.mjs",
				"./plugin-sdk/provider-auth": "./provider-auth.mjs",
			},
		}),
	);
	const logImport = (name: string) =>
		importLog
			? `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(importLog)}, ${JSON.stringify(`${name}\n`)});\n`
			: "";
	writeFileSync(
		join(packageRoot, "config-mutation.mjs"),
		`${logImport("config-mutation")}import { readFileSync, writeFileSync } from "node:fs";
const configPath = ${JSON.stringify(configPath)};
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasLegacyMemorySearch = (config) => {
  const agents = isRecord(config) ? config.agents : undefined;
  const defaults = isRecord(agents) ? agents.defaults : undefined;
  return isRecord(defaults) && Object.hasOwn(defaults, "memorySearch");
};
export async function readConfigFileSnapshotForWrite() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return { snapshot: { valid: !hasLegacyMemorySearch(config), config, sourceConfig: structuredClone(config) } };
}
export async function mutateConfigFile(options) {
  ${options.beforeMutation ? `writeFileSync(configPath, ${JSON.stringify(JSON.stringify(options.beforeMutation))});` : ""}
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  await options.mutate(config, { snapshot: {}, previousHash: null, attempt: 1 });
  if (hasLegacyMemorySearch(config)) throw new Error("OpenClaw config validation failed");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
}
`,
	);
	writeFileSync(
		join(packageRoot, "device-bootstrap.mjs"),
		`${logImport("device-bootstrap")}export const normalizeDeviceBootstrapProfile = (profile) => profile;\n`,
	);
	writeFileSync(
		join(packageRoot, "provider-auth.mjs"),
		`${logImport("provider-auth")}export const ensureAuthProfileStoreForLocalUpdate = () => ({ profiles: {} });
export const updateAuthProfileStoreWithLock = async () => ({});
export const listProfilesForProvider = () => [];
export const removeProviderAuthProfilesWithLock = async () => ({});
`,
	);
	return configPath;
}
