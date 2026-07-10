import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const TRANSPARENT_EGRESS_TRANSPORT_VERSION = "clawdi-transparent-egress-v1";
export const TRANSPARENT_EGRESS_TABLE = "clawdi_transparent_egress";

export interface TransparentEgressNftRulesInput {
	table?: string;
	transportVersion?: string;
	runtimeUid: number;
	egressUid: number;
	transparentPort: number;
	replaceExistingTable?: boolean;
}

export interface TransparentEgressEnvConfig {
	envFile?: string;
	runtimeUser: string;
	egressUser: string;
	runtimeUid: number;
	egressUid: number;
	transparentPort: number;
	nftTable: string;
	profileBundlePath: string;
	secretFilePath: string;
	caDir: string;
	caCertPath: string;
	systemCaBundle: string;
	engineVersion: string;
	engineUrl: string;
	engineSha256: string;
	engineBinaryPath: string;
	addonPath: string;
	addonSha256: string;
}

export interface TransparentEgressApplyResult {
	table: string;
	runtimeUid: number;
	egressUid: number;
	transparentPort: number;
}

export function buildTransparentEgressNftRules(input: TransparentEgressNftRulesInput): string {
	validateUid(input.runtimeUid, "runtimeUid");
	validateUid(input.egressUid, "egressUid");
	validatePort(input.transparentPort);
	const table = input.table ?? TRANSPARENT_EGRESS_TABLE;
	const transportVersion = input.transportVersion ?? TRANSPARENT_EGRESS_TRANSPORT_VERSION;
	validateNftIdentifier(table, "table");
	const lines = [
		`# ${transportVersion}`,
		...(input.replaceExistingTable ? [`delete table inet ${table}`] : []),
		`add table inet ${table}`,
		`add chain inet ${table} output_nat { type nat hook output priority -100; policy accept; }`,
		`add rule inet ${table} output_nat meta skuid ${input.egressUid} accept`,
		`add rule inet ${table} output_nat meta skuid ${input.runtimeUid} tcp dport { 80, 443 } redirect to :${input.transparentPort}`,
		"",
	];
	return lines.join("\n");
}

export function buildTransparentEgressNftCleanupRules(table = TRANSPARENT_EGRESS_TABLE): string {
	validateNftIdentifier(table, "table");
	return [`# ${TRANSPARENT_EGRESS_TRANSPORT_VERSION}`, `delete table inet ${table}`, ""].join("\n");
}

export function applyTransparentEgressNftRulesFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): TransparentEgressApplyResult {
	const config = loadTransparentEgressEnvConfig(env);
	const rules = buildTransparentEgressNftRules({
		table: config.nftTable,
		runtimeUid: config.runtimeUid,
		egressUid: config.egressUid,
		transparentPort: config.transparentPort,
		replaceExistingTable: nftTableExists(config.nftTable),
	});
	applyNftRules(rules, "apply");
	return {
		table: config.nftTable,
		runtimeUid: config.runtimeUid,
		egressUid: config.egressUid,
		transparentPort: config.transparentPort,
	};
}

export function cleanupTransparentEgressNftRulesFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): void {
	const config = loadTransparentEgressEnvConfig(env);
	cleanupTransparentEgressNftRules(config.nftTable);
}

export function cleanupTransparentEgressNftRules(table = TRANSPARENT_EGRESS_TABLE): void {
	if (!nftTableExists(table)) return;
	applyNftRules(buildTransparentEgressNftCleanupRules(table), "cleanup");
}

export function loadTransparentEgressEnvConfig(
	env: NodeJS.ProcessEnv = process.env,
): TransparentEgressEnvConfig {
	const envFile = firstNonempty(env.CLAWDI_EGRESS_ENV_FILE);
	const fileConfig = envFile ? parseEnvFile(envFile) : {};
	const config: Record<string, string | undefined> = { ...fileConfig };
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith("CLAWDI_")) config[key] = value;
	}
	const runtimeUser = requiredConfig(config, "CLAWDI_RUNTIME_USER");
	const egressUser = requiredConfig(config, "CLAWDI_EGRESS_USER");
	const runtimeUid = numericConfig(config, "CLAWDI_RUNTIME_UID");
	const egressUid = numericConfig(config, "CLAWDI_EGRESS_UID");
	const transparentPort = numericConfig(config, "CLAWDI_EGRESS_TRANSPARENT_PORT");
	const nftTable = requiredConfig(config, "CLAWDI_EGRESS_NFT_TABLE");
	validateNftIdentifier(nftTable, "CLAWDI_EGRESS_NFT_TABLE");
	return {
		envFile,
		runtimeUser,
		egressUser,
		runtimeUid,
		egressUid,
		transparentPort,
		nftTable,
		profileBundlePath: requiredConfig(config, "CLAWDI_EGRESS_PROFILE_BUNDLE"),
		secretFilePath: config.CLAWDI_EGRESS_SECRET_FILE?.trim() ?? "",
		caDir: requiredConfig(config, "CLAWDI_EGRESS_CA_DIR"),
		caCertPath: requiredConfig(config, "CLAWDI_EGRESS_CA_CERT"),
		systemCaBundle: requiredConfig(config, "CLAWDI_EGRESS_SYSTEM_CA_BUNDLE"),
		engineVersion: requiredConfig(config, "CLAWDI_EGRESS_ENGINE_VERSION"),
		engineUrl: requiredConfig(config, "CLAWDI_EGRESS_ENGINE_URL"),
		engineSha256: requiredConfig(config, "CLAWDI_EGRESS_ENGINE_SHA256").toLowerCase(),
		engineBinaryPath: requiredConfig(config, "CLAWDI_EGRESS_ENGINE_BINARY_PATH"),
		addonPath: requiredConfig(config, "CLAWDI_EGRESS_ADDON_PATH"),
		addonSha256: requiredConfig(config, "CLAWDI_EGRESS_ADDON_SHA256").toLowerCase(),
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
	if (!value) throw new Error(`${key} is required for transparent egress`);
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
