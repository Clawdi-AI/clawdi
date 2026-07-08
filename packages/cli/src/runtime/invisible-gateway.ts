import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const INVISIBLE_GATEWAY_TRANSPORT_VERSION = "clawdi-invisible-gateway-v1";
export const INVISIBLE_GATEWAY_TABLE = "clawdi_invisible_gateway";
const INVISIBLE_GATEWAY_REDIRECT_CT_MARK = "0xc1a0d1";

interface InvisibleGatewayNftRulesInput {
	agentUid: number;
	sidecarUid: number;
	transparentPort: number;
	resolverIpv4: string[];
	resolverIpv6: string[];
	replaceExistingTable?: boolean;
}

export interface InvisibleGatewayApplyResult {
	table: string;
	agentUid: number;
	sidecarUid: number;
	transparentPort: number;
	resolverIpv4: string[];
	resolverIpv6: string[];
}

export function buildInvisibleGatewayNftRules(input: InvisibleGatewayNftRulesInput): string {
	validateUid(input.agentUid, "agentUid");
	validateUid(input.sidecarUid, "sidecarUid");
	validatePort(input.transparentPort);
	const resolverIpv4 = unique(input.resolverIpv4.filter(isIpv4));
	const resolverIpv6 = unique(input.resolverIpv6.filter(isIpv6));
	const lines = [
		`# ${INVISIBLE_GATEWAY_TRANSPORT_VERSION}`,
		...(input.replaceExistingTable ? [`delete table inet ${INVISIBLE_GATEWAY_TABLE}`] : []),
		`add table inet ${INVISIBLE_GATEWAY_TABLE}`,
		`add set inet ${INVISIBLE_GATEWAY_TABLE} resolver4 { type ipv4_addr; flags interval; }`,
		`add set inet ${INVISIBLE_GATEWAY_TABLE} resolver6 { type ipv6_addr; flags interval; }`,
		...nftAddElements("resolver4", resolverIpv4),
		...nftAddElements("resolver6", resolverIpv6),
		`add chain inet ${INVISIBLE_GATEWAY_TABLE} output_nat { type nat hook output priority -100; policy accept; }`,
		`add chain inet ${INVISIBLE_GATEWAY_TABLE} output_filter { type filter hook output priority 0; policy accept; }`,
		`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_nat meta skuid ${input.sidecarUid} accept`,
		`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_nat meta skuid ${input.agentUid} tcp dport { 80, 443 } ct mark set ${INVISIBLE_GATEWAY_REDIRECT_CT_MARK} redirect to :${input.transparentPort}`,
		`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_filter meta skuid ${input.sidecarUid} accept`,
		`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_filter meta skuid ${input.agentUid} oifname "lo" accept`,
		`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_filter meta skuid ${input.agentUid} oifname "lo" tcp dport ${input.transparentPort} accept`,
		`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_filter meta skuid ${input.agentUid} ct mark ${INVISIBLE_GATEWAY_REDIRECT_CT_MARK} accept`,
		...resolverIpv4.flatMap((addr) => [
			`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_filter meta skuid ${input.agentUid} ip daddr ${addr} udp dport 53 accept`,
			`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_filter meta skuid ${input.agentUid} ip daddr ${addr} tcp dport 53 accept`,
		]),
		...resolverIpv6.flatMap((addr) => [
			`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_filter meta skuid ${input.agentUid} ip6 daddr ${addr} udp dport 53 accept`,
			`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_filter meta skuid ${input.agentUid} ip6 daddr ${addr} tcp dport 53 accept`,
		]),
		`add rule inet ${INVISIBLE_GATEWAY_TABLE} output_filter meta skuid ${input.agentUid} counter drop`,
		"",
	];
	return `${lines.join("\n")}`;
}

export function applyInvisibleGatewayRulesFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): InvisibleGatewayApplyResult {
	const agentUid = numericEnv(env.CLAWDI_EGRESS_AGENT_UID) ?? runtimeUserUid(env);
	const sidecarUid = numericEnv(env.CLAWDI_MITM_SIDECAR_UID) ?? 0;
	const transparentPort = numericEnv(env.CLAWDI_MITM_TRANSPARENT_PORT);
	if (transparentPort === null) {
		throw new Error("CLAWDI_MITM_TRANSPARENT_PORT is required for invisible gateway egress");
	}
	const resolvers = readResolverAddresses(env.CLAWDI_RESOLV_CONF?.trim() || "/etc/resolv.conf");
	const rules = buildInvisibleGatewayNftRules({
		agentUid,
		sidecarUid,
		transparentPort,
		resolverIpv4: resolvers.ipv4,
		resolverIpv6: resolvers.ipv6,
		replaceExistingTable: nftTableExists(INVISIBLE_GATEWAY_TABLE),
	});
	const result = spawnSync("nft", ["-f", "-"], {
		input: rules,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`nft apply failed${detail ? `\n${detail}` : ""}`);
	}
	return {
		table: INVISIBLE_GATEWAY_TABLE,
		agentUid,
		sidecarUid,
		transparentPort,
		resolverIpv4: resolvers.ipv4,
		resolverIpv6: resolvers.ipv6,
	};
}

function nftTableExists(table: string): boolean {
	const result = spawnSync("nft", ["list", "table", "inet", table], {
		encoding: "utf8",
		stdio: ["ignore", "ignore", "ignore"],
	});
	return result.status === 0;
}

export function readResolverAddresses(path: string): { ipv4: string[]; ipv6: string[] } {
	let content = "";
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return { ipv4: [], ipv6: [] };
	}
	const addresses = content
		.split(/\r?\n/)
		.map((line) => line.replace(/#.*/, "").trim().split(/\s+/))
		.filter((parts) => parts[0] === "nameserver" && typeof parts[1] === "string")
		.map((parts) => parts[1] ?? "");
	return {
		ipv4: unique(addresses.filter(isIpv4)),
		ipv6: unique(addresses.filter(isIpv6)),
	};
}

function runtimeUserUid(env: NodeJS.ProcessEnv): number {
	const runtimeUser = env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	const result = spawnSync("id", ["-u", runtimeUser], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`could not resolve runtime uid for ${runtimeUser}`);
	}
	const uid = numericEnv(result.stdout.trim());
	if (uid === null) throw new Error(`invalid runtime uid for ${runtimeUser}`);
	return uid;
}

function nftAddElements(setName: "resolver4" | "resolver6", values: string[]): string[] {
	if (values.length === 0) return [];
	return [`add element inet ${INVISIBLE_GATEWAY_TABLE} ${setName} { ${values.join(", ")} }`];
}

function numericEnv(value: string | undefined): number | null {
	if (!value?.trim()) return null;
	const parsed = Number.parseInt(value.trim(), 10);
	return Number.isInteger(parsed) && String(parsed) === value.trim() ? parsed : null;
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

function isIpv4(value: string): boolean {
	return /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value);
}

function isIpv6(value: string): boolean {
	return value.includes(":") && /^[0-9A-Fa-f:.]+$/.test(value);
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort();
}
