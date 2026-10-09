import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../serve/log";
import {
	beginHermesConfigTransaction,
	commitHermesConfigTransaction,
	getHermesRawConfigValue,
	type HermesConfigTransaction,
	HermesConfigYamlInvalidError,
	reconcileHermesConfigValue,
} from "./hermes-config";
import { listHermesProfileNames } from "./hermes-profiles";
import { managedMcpHeaderPlaceholder } from "./hosted-egress-profiles";
import type { RuntimeManifest } from "./manifest-contract";
import { type RuntimeInstallObservation, runtimeCommandPath } from "./manifest-install";
import {
	type HostedMcpServerDesiredState,
	hostedMcpDesiredStateSchema,
} from "./manifest-resources";
import { canonicalJsonEqual, isPlainRecord } from "./manifest-shared";
import type { RuntimePaths } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import type { RuntimeName } from "./run-config";
import {
	executableExists,
	type RuntimeUserIdentity,
	runRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";

interface HostedMcpIntent {
	servers: Record<string, HostedMcpServerDesiredState>;
}
export const HOSTED_RUNTIME_TARGETS = [
	"openclaw",
	"hermes",
] as const satisfies readonly RuntimeName[];
export function hostedMcpIntent(manifest: RuntimeManifest): HostedMcpIntent {
	const value = manifest.projection?.mcp;
	if (value === undefined) return { servers: {} };
	return { servers: hostedMcpDesiredStateSchema.parse(value).servers };
}
export function applyHostedMcpProjections(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
	workspaceRoot: string,
	hermesConfig: HermesConfigTransaction | null,
): void {
	const plan = buildHostedMcpReconciliationPlan(manifest, paths, observations, hermesConfig);
	for (const runtime of [...plan.runtimes].sort((left, right) =>
		left.name === right.name ? 0 : left.name === "hermes" ? -1 : 1,
	)) {
		if (runtime.mutations.length === 0) continue;
		if (runtime.name === "hermes") {
			if (!runtime.commandPath || !executableExists(runtime.commandPath) || !hermesConfig) {
				throw new Error("could not mutate managed Hermes MCP servers: runtime is unavailable");
			}
			applyHermesMcpMutations(hermesConfig, runtime.native.servers, runtime.mutations);
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
	}
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
}
function buildHostedMcpReconciliationPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	observations: ReadonlyMap<string, RuntimeInstallObservation>,
	hermesConfig: HermesConfigTransaction | null = null,
): HostedMcpReconciliationPlan {
	const intent = hostedMcpIntent(manifest);
	const home = hostedRuntimeProjectionHome(manifest, paths);
	const runtimes = HOSTED_RUNTIME_TARGETS.map((name) => {
		const desiredServers = manifest.runtimes[name]?.enabled === true ? intent.servers : {};
		const observation = observations.get(name);
		const commandPath = observation?.commandPath ?? runtimeCommandPath(name, home);
		const runtimeAvailable = Boolean(commandPath && executableExists(commandPath));
		if (name === "hermes" && Object.keys(desiredServers).length > 0 && !runtimeAvailable) {
			throw new Error("could not inspect managed Hermes MCP servers: runtime is unavailable");
		}
		const native =
			name === "openclaw" || runtimeAvailable
				? readHostedMcpNativeState(name, home, commandPath, hermesConfig)
				: { servers: {} };
		const mutations = planHostedMcpMutations(name, native.servers, desiredServers);
		const hasSet = mutations.some((mutation) => mutation.kind === "set");
		if (hasSet && (!observation?.enabled || observation.status === "install_failed")) {
			throw new Error(`could not apply managed ${name} MCP servers: runtime is unavailable`);
		}
		return { name, native, mutations, commandPath };
	});
	return { home, runtimes };
}
class HostedMcpOwnershipError extends Error {}
function planHostedMcpMutations(
	name: HostedMcpTarget,
	servers: Record<string, unknown>,
	desiredServers: Record<string, HostedMcpServerDesiredState>,
): HostedMcpMutation[] {
	const managedServerNames = new Set(
		Object.entries(servers).flatMap(([serverName, server]) =>
			hostedMcpNativeServerIsManaged(serverName, server) ? [serverName] : [],
		),
	);
	for (const serverName of Object.keys(desiredServers).sort()) {
		if (Object.hasOwn(servers, serverName) && !managedServerNames.has(serverName)) {
			throw new HostedMcpOwnershipError(
				`refusing to replace unmanaged ${name} MCP server ${serverName}`,
			);
		}
	}
	const mutations: HostedMcpMutation[] = [];
	for (const serverName of [...managedServerNames].sort()) {
		if (!Object.hasOwn(desiredServers, serverName) && Object.hasOwn(servers, serverName)) {
			mutations.push({ kind: "remove", serverName });
		}
	}
	for (const [serverName, desired] of Object.entries(desiredServers).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const server = hostedMcpNativeServerConfig(name, serverName, desired);
		if (!canonicalJsonEqual(servers[serverName], server)) {
			mutations.push({ kind: "set", serverName, server });
		}
	}
	return mutations;
}
function applyHermesMcpMutations(
	transaction: HermesConfigTransaction,
	servers: Record<string, unknown>,
	mutations: HostedMcpMutation[],
): void {
	if (mutations.length === 0) return;
	const nextServers = { ...servers };
	for (const mutation of mutations) {
		if (mutation.kind === "remove") delete nextServers[mutation.serverName];
		else nextServers[mutation.serverName] = mutation.server;
	}
	reconcileHermesConfigValue(
		transaction,
		"mcp_servers",
		Object.keys(nextServers).length > 0 ? nextServers : undefined,
	);
}
let profileDiscoveryWarningLogged = false;
export function reconcileHostedHermesProfileMcp(
	manifest: RuntimeManifest,
	home: string,
	command: string | null,
	defaultConfig: HermesConfigTransaction | null,
	identity: RuntimeUserIdentity,
): string[] {
	if (!command || !executableExists(command)) return [];
	let names: string[];
	try {
		// Upstream _get_profiles_root() anchors profiles to the same root used by discovery.
		const profilesRoot = join(home, ".hermes", "profiles");
		if (!existsSync(profilesRoot) || readdirSync(profilesRoot).length === 0) return [];
		names = listHermesProfileNames(home);
	} catch {
		if (!profileDiscoveryWarningLogged) {
			profileDiscoveryWarningLogged = true;
			log.warn("runtime.hermes-profile-mcp.skipped", { reason: "profile_discovery_failed" });
		}
		return [];
	}
	if (names.length === 1 && names[0] === "default") return [];
	const desired =
		manifest.runtimes.hermes?.enabled === true ? hostedMcpIntent(manifest).servers : {};
	const errors: string[] = [];
	const seenPaths = new Set(defaultConfig ? [defaultConfig.path] : []);
	for (const profile of names) {
		let reason = "config_path_or_read_failed";
		try {
			const transaction = beginHermesConfigTransaction({ command, profile, home, cwd: home });
			if (seenPaths.has(transaction.path)) continue;
			seenPaths.add(transaction.path);
			reason = "config_invalid";
			const native = readHostedMcpNativeState("hermes", home, command, transaction);
			const mutations = planHostedMcpMutations("hermes", native.servers, desired);
			applyHermesMcpMutations(transaction, native.servers, mutations);
			reason = "config_commit_failed";
			const result = withRuntimeUserFileAccess(
				() => commitHermesConfigTransaction(transaction),
				identity,
			);
			if (result === "conflict")
				errors.push(`Hermes profile MCP projection failed (profile ${profile}): config_conflict`);
		} catch (error) {
			if (error instanceof HermesConfigYamlInvalidError) reason = "config_invalid";
			errors.push(
				`Hermes profile MCP projection failed (profile ${profile}): ${error instanceof HostedMcpOwnershipError ? error.message : reason}`,
			);
		}
	}
	return errors;
}

function hostedMcpNativeServerIsManaged(serverName: string, server: unknown): boolean {
	if (!isPlainRecord(server) || !isPlainRecord(server.headers)) return false;
	return Object.entries(server.headers).some(
		([headerName, value]) =>
			typeof value === "string" &&
			value.endsWith(managedMcpHeaderPlaceholder(serverName, headerName)),
	);
}
function readHostedMcpNativeState(
	name: HostedMcpTarget,
	home: string,
	commandPath: string | null,
	hermesConfig: HermesConfigTransaction | null,
): HostedMcpNativeState {
	if (name === "hermes") {
		if (!commandPath || !hermesConfig) throw new Error("Hermes config command is unavailable");
		const current = getHermesRawConfigValue(hermesConfig, "mcp_servers");
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
	runtime: HostedMcpTarget,
	serverName: string,
	desired: HostedMcpServerDesiredState,
) {
	return {
		// OpenClaw shares the explicit request budget with catalog discovery;
		// without it, tools/list has a separate 1.5-second default.
		...(runtime === "openclaw" ? { requestTimeoutMs: 420_000 } : {}),
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
	hermesConfig: HermesConfigTransaction | null,
): void {
	buildHostedMcpReconciliationPlan(manifest, paths, observations, hermesConfig);
}
