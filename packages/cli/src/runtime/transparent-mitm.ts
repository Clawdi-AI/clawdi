import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const TRANSPARENT_MITM_TRANSPORT_VERSION = "clawdi-transparent-mitm-v1";
export const TRANSPARENT_MITM_TABLE = "clawdi_transparent_mitm";

export interface TransparentMitmNftRulesInput {
	table?: string;
	transportVersion?: string;
	runtimeUid: number;
	mitmUid: number;
	transparentPort: number;
	replaceExistingTable?: boolean;
}

export interface TransparentMitmEnvConfig {
	envFile?: string;
	runtimeUser: string;
	mitmUser: string;
	runtimeUid: number;
	mitmUid: number;
	transparentPort: number;
	nftTable: string;
	profileBundlePath: string;
	secretFilePath: string;
	caDir: string;
	caCertPath: string;
	systemCaBundle: string;
	mitmproxyVersion: string;
	mitmproxyUrl: string;
	mitmproxySha256: string;
	mitmproxyBinaryPath: string;
	mitmproxyAddonPath: string;
	mitmproxyAddonSha256: string;
}

export interface TransparentMitmApplyResult {
	table: string;
	runtimeUid: number;
	mitmUid: number;
	transparentPort: number;
}

export function buildTransparentMitmNftRules(input: TransparentMitmNftRulesInput): string {
	validateUid(input.runtimeUid, "runtimeUid");
	validateUid(input.mitmUid, "mitmUid");
	validatePort(input.transparentPort);
	const table = input.table ?? TRANSPARENT_MITM_TABLE;
	const transportVersion = input.transportVersion ?? TRANSPARENT_MITM_TRANSPORT_VERSION;
	validateNftIdentifier(table, "table");
	const lines = [
		`# ${transportVersion}`,
		...(input.replaceExistingTable ? [`delete table inet ${table}`] : []),
		`add table inet ${table}`,
		`add chain inet ${table} output_nat { type nat hook output priority -100; policy accept; }`,
		`add rule inet ${table} output_nat meta skuid ${input.mitmUid} accept`,
		`add rule inet ${table} output_nat meta skuid ${input.runtimeUid} tcp dport { 80, 443 } redirect to :${input.transparentPort}`,
		"",
	];
	return lines.join("\n");
}

export function buildTransparentMitmNftCleanupRules(table = TRANSPARENT_MITM_TABLE): string {
	validateNftIdentifier(table, "table");
	return [`# ${TRANSPARENT_MITM_TRANSPORT_VERSION}`, `delete table inet ${table}`, ""].join("\n");
}

export function applyTransparentMitmNftRulesFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): TransparentMitmApplyResult {
	const config = loadTransparentMitmEnvConfig(env);
	const rules = buildTransparentMitmNftRules({
		table: config.nftTable,
		runtimeUid: config.runtimeUid,
		mitmUid: config.mitmUid,
		transparentPort: config.transparentPort,
		replaceExistingTable: nftTableExists(config.nftTable),
	});
	applyNftRules(rules, "apply");
	return {
		table: config.nftTable,
		runtimeUid: config.runtimeUid,
		mitmUid: config.mitmUid,
		transparentPort: config.transparentPort,
	};
}

export function cleanupTransparentMitmNftRulesFromEnv(env: NodeJS.ProcessEnv = process.env): void {
	const config = loadTransparentMitmEnvConfig(env);
	cleanupTransparentMitmNftRules(config.nftTable);
}

export function cleanupTransparentMitmNftRules(table = TRANSPARENT_MITM_TABLE): void {
	if (!nftTableExists(table)) return;
	applyNftRules(buildTransparentMitmNftCleanupRules(table), "cleanup");
}

export function loadTransparentMitmEnvConfig(
	env: NodeJS.ProcessEnv = process.env,
): TransparentMitmEnvConfig {
	const envFile = firstNonempty(env.CLAWDI_MITM_ENV_FILE);
	const fileConfig = envFile ? parseEnvFile(envFile) : {};
	const config: Record<string, string | undefined> = { ...fileConfig };
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith("CLAWDI_")) config[key] = value;
	}
	const runtimeUser = requiredConfig(config, "CLAWDI_RUNTIME_USER");
	const mitmUser = requiredConfig(config, "CLAWDI_MITM_USER");
	const runtimeUid = numericConfig(config, "CLAWDI_RUNTIME_UID");
	const mitmUid = numericConfig(config, "CLAWDI_MITM_UID");
	const transparentPort = numericConfig(config, "CLAWDI_MITM_TRANSPARENT_PORT");
	const nftTable = requiredConfig(config, "CLAWDI_MITM_NFT_TABLE");
	validateNftIdentifier(nftTable, "CLAWDI_MITM_NFT_TABLE");
	return {
		envFile,
		runtimeUser,
		mitmUser,
		runtimeUid,
		mitmUid,
		transparentPort,
		nftTable,
		profileBundlePath: requiredConfig(config, "CLAWDI_MITM_PROFILE_BUNDLE"),
		secretFilePath: config.CLAWDI_MITM_SECRET_FILE?.trim() ?? "",
		caDir: requiredConfig(config, "CLAWDI_MITM_CA_DIR"),
		caCertPath: requiredConfig(config, "CLAWDI_MITM_CA_CERT"),
		systemCaBundle: requiredConfig(config, "CLAWDI_MITM_SYSTEM_CA_BUNDLE"),
		mitmproxyVersion: requiredConfig(config, "CLAWDI_MITMPROXY_VERSION"),
		mitmproxyUrl: requiredConfig(config, "CLAWDI_MITMPROXY_URL"),
		mitmproxySha256: requiredConfig(config, "CLAWDI_MITMPROXY_SHA256").toLowerCase(),
		mitmproxyBinaryPath: requiredConfig(config, "CLAWDI_MITMPROXY_BINARY_PATH"),
		mitmproxyAddonPath: requiredConfig(config, "CLAWDI_MITMPROXY_ADDON_PATH"),
		mitmproxyAddonSha256: requiredConfig(config, "CLAWDI_MITMPROXY_ADDON_SHA256").toLowerCase(),
	};
}

export function parseEnvFile(path: string): Record<string, string> {
	const output: Record<string, string> = {};
	for (const raw of readFileSync(path, "utf-8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || !line.includes("=")) continue;
		const [key, ...rest] = line.split("=");
		const normalizedKey = key?.trim() ?? "";
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalizedKey)) continue;
		output[normalizedKey] = unquoteEnvValue(rest.join("=").trim());
	}
	return output;
}

function applyNftRules(rules: string, action: "apply" | "cleanup"): void {
	const result = spawnSync("nft", ["-f", "-"], {
		input: rules,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`nft ${action} failed${detail ? `\n${detail}` : ""}`);
	}
}

function nftTableExists(table: string): boolean {
	validateNftIdentifier(table, "table");
	const result = spawnSync("nft", ["list", "table", "inet", table], {
		encoding: "utf8",
		stdio: ["ignore", "ignore", "ignore"],
	});
	return result.status === 0;
}

function requiredConfig(config: Record<string, string | undefined>, key: string): string {
	const value = config[key]?.trim();
	if (!value) throw new Error(`${key} is required for transparent MITM`);
	return value;
}

function numericConfig(config: Record<string, string | undefined>, key: string): number {
	const raw = requiredConfig(config, key);
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw) {
		throw new Error(`${key} must be numeric`);
	}
	return parsed;
}

function firstNonempty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function unquoteEnvValue(value: string): string {
	if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
		value = value.slice(1, -1);
	}
	return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function validateUid(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0 || value > 4_294_967_295) {
		throw new Error(`${name} must be a numeric uid`);
	}
}

function validatePort(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error("transparentPort must be a TCP port");
	}
}

function validateNftIdentifier(value: string, name: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new Error(`${name} must be a safe nft identifier`);
	}
}
