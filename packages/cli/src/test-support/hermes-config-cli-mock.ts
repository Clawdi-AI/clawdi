import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const DEFAULT_CONFIG: Record<string, unknown> = {
	model: "",
	providers: {},
	display: {
		platforms: {
			telegram: { streaming: true },
			discord: { streaming: false },
			slack: { streaming: false },
		},
	},
};

const configPath = join(
	process.env.HERMES_HOME?.trim() || join(process.env.HOME ?? "", ".hermes"),
	"config.yaml",
);

function readConfig(): Record<string, unknown> {
	if (!existsSync(configPath)) return {};
	const parsed = parseYaml(readFileSync(configPath, "utf8")) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("config must be an object");
	}
	return parsed as Record<string, unknown>;
}

function writeConfig(config: Record<string, unknown>): void {
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, stringifyYaml(config));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(defaults: unknown, user: unknown): unknown {
	if (!isRecord(defaults) || !isRecord(user)) return structuredClone(user);
	const merged: Record<string, unknown> = structuredClone(defaults);
	for (const [key, value] of Object.entries(user)) {
		merged[key] = Object.hasOwn(merged, key) ? deepMerge(merged[key], value) : structuredClone(value);
	}
	return merged;
}

function expandEnvironment(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(/\$\{([^}]+)\}/g, (reference, rawName: string) => {
			const name = rawName.startsWith("env:") ? rawName.slice(4).trim() : rawName.trim();
			if (!name || (rawName.includes(":") && !rawName.startsWith("env:"))) return reference;
			return process.env[name] ?? reference;
		});
	}
	if (Array.isArray(value)) return value.map(expandEnvironment);
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, expandEnvironment(entry)]),
		);
	}
	return value;
}

function resolvedConfig(config: Record<string, unknown>): Record<string, unknown> {
	return expandEnvironment(deepMerge(DEFAULT_CONFIG, config)) as Record<string, unknown>;
}

function getNested(config: Record<string, unknown>, key: string): unknown | undefined {
	let current: unknown = config;
	for (const part of key.split(".")) {
		if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
		if (!Object.hasOwn(current, part)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function setNested(config: Record<string, unknown>, key: string, value: unknown): void {
	const parts = key.split(".");
	let current = config;
	for (const part of parts.slice(0, -1)) {
		const existing = current[part];
		if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}
	const leaf = parts.at(-1);
	if (leaf) current[leaf] = value;
}

function unsetNested(config: Record<string, unknown>, key: string): boolean {
	const parts = key.split(".");
	const parents: Array<[Record<string, unknown>, string]> = [];
	let current = config;
	for (const part of parts.slice(0, -1)) {
		const next = current[part];
		if (typeof next !== "object" || next === null || Array.isArray(next)) return false;
		parents.push([current, part]);
		current = next as Record<string, unknown>;
	}
	const leaf = parts.at(-1);
	if (!leaf || !Object.hasOwn(current, leaf)) return false;
	delete current[leaf];
	for (const [parent, part] of parents.reverse()) {
		const child = parent[part];
		if (typeof child === "object" && child !== null && !Array.isArray(child)) {
			if (Object.keys(child).length === 0) delete parent[part];
		}
	}
	return true;
}

function parseValue(raw: string): unknown {
	const value = raw.trim();
	if (value.startsWith("{") || value.startsWith("[")) return parseYaml(value) as unknown;
	if (/^(true|yes|on)$/i.test(value)) return true;
	if (/^(false|no|off)$/i.test(value)) return false;
	if (/^\d+$/.test(value)) return Number(value);
	if (/^\d+\.\d+$/.test(value)) return Number(value);
	return raw;
}

const [, action, ...args] = process.argv.slice(2);

try {
	if (action === "path") {
		console.log(configPath);
		process.exit(0);
	}
	const config = readConfig();
	if (action === "get") {
		const key = args[0] ?? "";
		const value = getNested(resolvedConfig(config), key);
		if (value === undefined) {
			console.error(`Config key not set: ${key}`);
			process.exit(1);
		}
		console.log(JSON.stringify(value));
		process.exit(0);
	}
	if (action === "set") {
		const offset = args[0] === "--force" ? 1 : 0;
		const key = args[offset] ?? "";
		const raw = args[offset + 1];
		if (!key || raw === undefined) process.exit(2);
		setNested(config, key, parseValue(raw));
		writeConfig(config);
		process.exit(0);
	}
	if (action === "unset") {
		const key = args[0] ?? "";
		if (!unsetNested(config, key)) {
			console.error(`Config key not set: ${key}`);
			process.exit(1);
		}
		writeConfig(config);
		process.exit(0);
	}
	process.exit(64);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
