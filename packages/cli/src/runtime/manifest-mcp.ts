import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getHermesRawConfigValue, reconcileHermesConfigValue } from "./hermes-config";
import { managedMcpHeaderPlaceholder } from "./hosted-egress-profiles";
import type { RuntimeManifest } from "./manifest-contract";
import { type RuntimeInstallObservation, runtimeCommandPath } from "./manifest-install";
import {
	type HostedMcpServerDesiredState,
	hostedMcpDesiredStateSchema,
} from "./manifest-resources";
import { canonicalJsonEqual, isPlainRecord, recordValue, writeJsonFile } from "./manifest-shared";
import type { RuntimePaths } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import type { RuntimeName } from "./run-config";
import { executableExists, runRuntimeUserCommand } from "./runtime-user-command";

export function hostedMcpProjectionDeclared(manifest: RuntimeManifest): boolean {
	return manifest.projection?.mcp !== undefined;
}
interface HostedMcpIntent {
	servers: Record<string, HostedMcpServerDesiredState>;
}
export const HOSTED_RUNTIME_TARGETS = [
	"openclaw",
	"hermes",
] as const satisfies readonly RuntimeName[];
// SUNSET: Remove v1 parsing and the projection-root fallback after every fleet host has written the v2 managed-resource ledger.
const HOSTED_MCP_LEDGER_V1_SCHEMA_VERSION = "clawdi.hostedManagedMcpServers.v1";
const HOSTED_MCP_LEDGER_SCHEMA_VERSION = "clawdi.hostedManagedMcpServers.v2";
const HOSTED_MCP_LEDGER_FILE = "managed-mcp-servers.json";
const HOSTED_MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
interface HostedMcpManagedLedger {
	schemaVersion: typeof HOSTED_MCP_LEDGER_SCHEMA_VERSION;
	runtimes: Partial<Record<(typeof HOSTED_RUNTIME_TARGETS)[number], string[]>>;
}
export function hostedMcpIntent(manifest: RuntimeManifest): HostedMcpIntent {
	const value = manifest.projection?.mcp;
	if (value === undefined) return { servers: {} };
	return { servers: hostedMcpDesiredStateSchema.parse(value).servers };
}
function hostedMcpLedgerPath(paths: RuntimePaths): string {
	return join(paths.managedResourceRoot, HOSTED_MCP_LEDGER_FILE);
}
function legacyHostedMcpLedgerPath(paths: RuntimePaths): string {
	return join(paths.projectionRoot, HOSTED_MCP_LEDGER_FILE);
}
function readHostedMcpManagedLedger(paths: RuntimePaths): HostedMcpManagedLedger {
	const path = hostedMcpLedgerPath(paths);
	const legacyPath = legacyHostedMcpLedgerPath(paths);
	const sourcePath = existsSync(path) ? path : existsSync(legacyPath) ? legacyPath : null;
	if (!sourcePath) {
		return { schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION, runtimes: {} };
	}
	let payload: unknown;
	try {
		payload = JSON.parse(readFileSync(sourcePath, "utf-8"));
	} catch (error) {
		throw new Error(
			`hosted MCP last-applied ledger is invalid: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (
		!isPlainRecord(payload) ||
		(payload.schemaVersion !== HOSTED_MCP_LEDGER_V1_SCHEMA_VERSION &&
			payload.schemaVersion !== HOSTED_MCP_LEDGER_SCHEMA_VERSION)
	) {
		throw new Error("hosted MCP last-applied ledger has an unsupported schema");
	}
	if (
		Object.keys(payload).length !== 2 ||
		!Object.hasOwn(payload, "schemaVersion") ||
		!Object.hasOwn(payload, "runtimes")
	) {
		throw new Error("hosted MCP last-applied ledger has invalid fields");
	}
	const runtimes = recordValue(payload.runtimes);
	if (
		!runtimes ||
		Object.keys(runtimes).some((name) => !HOSTED_RUNTIME_TARGETS.includes(name as never))
	) {
		throw new Error("hosted MCP last-applied ledger has invalid runtimes");
	}
	const normalized: HostedMcpManagedLedger["runtimes"] = {};
	for (const runtime of HOSTED_RUNTIME_TARGETS) {
		const runtimeOwnership = runtimes[runtime];
		if (runtimeOwnership === undefined) continue;
		// V1 values are untrusted legacy desired state. Migrate ownership by name only.
		const names =
			payload.schemaVersion === HOSTED_MCP_LEDGER_V1_SCHEMA_VERSION
				? isPlainRecord(runtimeOwnership)
					? Object.keys(runtimeOwnership)
					: null
				: Array.isArray(runtimeOwnership)
					? runtimeOwnership
					: null;
		if (!names) {
			throw new Error(`hosted MCP last-applied ledger has invalid ${runtime} servers`);
		}
		const normalizedNames = new Set<string>();
		for (const name of names) {
			if (typeof name !== "string" || !HOSTED_MCP_SERVER_NAME_PATTERN.test(name)) {
				throw new Error(`hosted MCP last-applied ledger has invalid ${runtime} server name`);
			}
			if (normalizedNames.has(name)) {
				throw new Error(`hosted MCP last-applied ledger has duplicate ${runtime} server name`);
			}
			normalizedNames.add(name);
		}
		if (normalizedNames.size > 0) normalized[runtime] = [...normalizedNames].sort();
	}
	return { schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION, runtimes: normalized };
}
function writeHostedMcpManagedLedger(paths: RuntimePaths, ledger: HostedMcpManagedLedger): void {
	writeJsonFile(
		hostedMcpLedgerPath(paths),
		{
			schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION,
			runtimes: Object.fromEntries(
				HOSTED_RUNTIME_TARGETS.flatMap((runtime) => {
					const names = ledger.runtimes[runtime];
					return names && names.length > 0 ? [[runtime, [...names].sort()]] : [];
				}),
			),
		},
		paths,
	);
}
export function applyHostedMcpProjections(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
	workspaceRoot: string,
): string[] {
	const plan = buildHostedMcpReconciliationPlan(manifest, paths, observations, workspaceRoot);
	const ledgerPath = hostedMcpLedgerPath(paths);
	const outputs = new Set<string>();
	// Apply Hermes first so both native runtimes converge before the
	// root-owned ownership ledger advances.
	for (const runtime of [...plan.runtimes].sort((left, right) =>
		left.name === right.name ? 0 : left.name === "hermes" ? -1 : 1,
	)) {
		if (runtime.mutations.length === 0) continue;
		if (runtime.name === "hermes") {
			if (!runtime.commandPath || !executableExists(runtime.commandPath)) {
				throw new Error("could not mutate managed Hermes MCP servers: runtime is unavailable");
			}
			const nextServers = { ...runtime.native.servers };
			for (const mutation of runtime.mutations) {
				if (mutation.kind === "remove") delete nextServers[mutation.serverName];
				else nextServers[mutation.serverName] = mutation.server;
			}
			reconcileHermesConfigValue(
				{ command: runtime.commandPath, home: plan.home, cwd: workspaceRoot },
				"mcp_servers",
				Object.keys(nextServers).length > 0 ? nextServers : undefined,
			);
			outputs.add(runtime.commandPath);
			continue;
		}
		if (!runtime.commandPath || !executableExists(runtime.commandPath)) {
			throw new Error("could not mutate managed OpenClaw MCP servers: runtime is unavailable");
		}
		for (const mutation of runtime.mutations) {
			const args =
				mutation.kind === "remove"
					? ["mcp", "unset", mutation.serverName]
					: ["mcp", "set", mutation.serverName, JSON.stringify(mutation.server)];
			runRuntimeUserCommand(runtime.commandPath, args, "", plan.home, workspaceRoot);
		}
		outputs.add(runtime.commandPath);
	}
	// The last-applied ownership map advances only after every native target.
	if (
		Object.keys(plan.nextLedger.runtimes).length > 0 ||
		existsSync(ledgerPath) ||
		existsSync(legacyHostedMcpLedgerPath(paths))
	) {
		writeHostedMcpManagedLedger(paths, plan.nextLedger);
	}
	return [...outputs];
}
type HostedMcpTarget = (typeof HOSTED_RUNTIME_TARGETS)[number];
type HostedMcpNativeServer = ReturnType<typeof hostedMcpNativeServerConfig>;
type HostedMcpMutation =
	| { kind: "remove"; serverName: string }
	| { kind: "set"; serverName: string; server: HostedMcpNativeServer };
interface HostedMcpNativeState {
	servers: Record<string, unknown>;
}
interface HostedMcpRuntimePlan {
	name: HostedMcpTarget;
	native: HostedMcpNativeState;
	mutations: HostedMcpMutation[];
	commandPath: string | null;
}
interface HostedMcpReconciliationPlan {
	home: string;
	runtimes: HostedMcpRuntimePlan[];
	nextLedger: HostedMcpManagedLedger;
}
function buildHostedMcpReconciliationPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
	cwd = hostedRuntimeProjectionHome(manifest, paths),
): HostedMcpReconciliationPlan {
	const intent = hostedMcpIntent(manifest);
	const home = hostedRuntimeProjectionHome(manifest, paths);
	const ledger = readHostedMcpManagedLedger(paths);
	const nextLedger: HostedMcpManagedLedger = {
		schemaVersion: HOSTED_MCP_LEDGER_SCHEMA_VERSION,
		runtimes: {},
	};
	const runtimes = HOSTED_RUNTIME_TARGETS.map((name) => {
		const desiredServers = manifest.runtimes[name]?.enabled === true ? intent.servers : {};
		const previousServerNames = new Set(ledger.runtimes[name] ?? []);
		const observation = observations.get(name);
		const commandPath = observation?.commandPath ?? runtimeCommandPath(name, home);
		const needsNativeState = Object.keys(desiredServers).length > 0 || previousServerNames.size > 0;
		if (name === "hermes" && needsNativeState && (!commandPath || !executableExists(commandPath))) {
			throw new Error("could not inspect managed Hermes MCP servers: runtime is unavailable");
		}
		const native = needsNativeState
			? readHostedMcpNativeState(name, home, commandPath, cwd)
			: { servers: {} };
		for (const serverName of Object.keys(desiredServers).sort()) {
			if (previousServerNames.has(serverName)) continue;
			if (Object.hasOwn(native.servers, serverName)) {
				throw new Error(`refusing to replace unmanaged ${name} MCP server ${serverName}`);
			}
		}
		const mutations: HostedMcpMutation[] = [];
		for (const serverName of [...previousServerNames].sort()) {
			if (!Object.hasOwn(desiredServers, serverName) && Object.hasOwn(native.servers, serverName)) {
				// The ledger owns this name even if its native value drifted. Native
				// absence, however, already satisfies deletion and must not invoke an
				// `mcp unset` command that rejects missing names.
				mutations.push({ kind: "remove", serverName });
			}
		}
		for (const [serverName, desired] of Object.entries(desiredServers).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			const server = hostedMcpNativeServerConfig(serverName, desired);
			if (!canonicalJsonEqual(native.servers[serverName], server)) {
				mutations.push({ kind: "set", serverName, server });
			}
		}
		if (Object.keys(desiredServers).length > 0) {
			nextLedger.runtimes[name] = Object.keys(desiredServers).sort();
		}
		const hasSet = mutations.some((mutation) => mutation.kind === "set");
		if (hasSet && (!observation?.enabled || observation.status === "install_failed")) {
			throw new Error(`could not apply managed ${name} MCP servers: runtime is unavailable`);
		}
		return { name, native, mutations, commandPath };
	});
	return { home, runtimes, nextLedger };
}
function readHostedMcpNativeState(
	name: HostedMcpTarget,
	home: string,
	commandPath: string | null,
	cwd: string,
): HostedMcpNativeState {
	if (name === "hermes") {
		if (!commandPath) throw new Error("Hermes config command is unavailable");
		const current = getHermesRawConfigValue({ command: commandPath, home, cwd }, "mcp_servers");
		if (!current.exists) return { servers: {} };
		if (!isPlainRecord(current.value)) {
			throw new Error("Hermes config field mcp_servers must be an object");
		}
		return { servers: current.value };
	}
	const path = join(home, ".openclaw", "openclaw.json");
	if (!existsSync(path)) return { servers: {} };
	const content = readFileSync(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`${name} config is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isPlainRecord(parsed)) throw new Error(`${name} config must be an object`);
	if (parsed.mcpServers !== undefined) {
		throw new Error(
			"openclaw config uses unsupported legacy field mcpServers; canonical MCP state is mcp.servers",
		);
	}
	const mcp = parsed.mcp;
	if (mcp !== undefined && !isPlainRecord(mcp)) {
		throw new Error("openclaw config field mcp must be an object");
	}
	const servers = isPlainRecord(mcp) ? mcp.servers : undefined;
	if (servers === undefined) return { servers: {} };
	if (!isPlainRecord(servers)) {
		throw new Error("openclaw config field mcp.servers must be an object");
	}
	return { servers };
}
function hostedMcpNativeServerConfig(
	serverName: string,
	desired: HostedMcpServerDesiredState,
):
	| { command: string; args: string[] }
	| { url: string; transport: "streamable-http" | "sse"; headers: Record<string, string> } {
	if ("command" in desired) return { command: desired.command, args: [...desired.args] };
	return {
		url: desired.url,
		transport: desired.transport,
		headers: Object.fromEntries(
			Object.entries(desired.headers).map(([name, value]) => [
				name,
				typeof value === "string"
					? value
					: `${value.prefix}${managedMcpHeaderPlaceholder(serverName, name)}`,
			]),
		),
	};
}
export function validateHostedMcpProjectionPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
): void {
	buildHostedMcpReconciliationPlan(manifest, paths, observations);
}
