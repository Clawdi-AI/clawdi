import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BuiltinMcpPackage, installBuiltinMcp, planBuiltinMcp } from "./builtin-mcp";
import {
	getHermesRawConfigValue,
	type HermesConfigTransaction,
	reconcileHermesConfigValue,
} from "./hermes-config";
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
	openClawWorkspaceRoot: string | null = null,
): void {
	const plan = buildHostedMcpReconciliationPlan(
		manifest,
		paths,
		observations,
		hermesConfig,
		openClawWorkspaceRoot,
	);
	for (const runtime of plan.runtimes)
		for (const artifact of runtime.packages) installBuiltinMcp(artifact);
	for (const runtime of [...plan.runtimes].sort((left, right) =>
		left.name === right.name ? 0 : left.name === "hermes" ? -1 : 1,
	)) {
		if (runtime.mutations.length === 0) continue;
		if (runtime.name === "hermes") {
			if (!runtime.commandPath || !executableExists(runtime.commandPath) || !hermesConfig) {
				throw new Error("could not mutate managed Hermes MCP servers: runtime is unavailable");
			}
			const nextServers = { ...runtime.native.servers };
			for (const mutation of runtime.mutations) {
				if (mutation.kind === "remove") delete nextServers[mutation.serverName];
				else nextServers[mutation.serverName] = mutation.server;
			}
			reconcileHermesConfigValue(
				hermesConfig,
				"mcp_servers",
				Object.keys(nextServers).length > 0 ? nextServers : undefined,
			);
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
type HostedMcpNativeServer =
	| ReturnType<typeof hostedMcpNativeServerConfig>
	| BuiltinMcpPackage["server"];
type HostedMcpMutation =
	| { kind: "remove"; serverName: string }
	| { kind: "set"; serverName: string; server: HostedMcpNativeServer };
interface HostedMcpNativeState {
	servers: Record<string, unknown>;
}
interface HostedMcpRuntimePlan {
	packages: BuiltinMcpPackage[];
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
	openClawWorkspaceRoot: string | null = null,
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
		const managedServerNames = new Set(
			Object.entries(native.servers).flatMap(([serverName, server]) =>
				hostedMcpNativeServerIsManaged(serverName, server, paths) ? [serverName] : [],
			),
		);
		for (const serverName of Object.keys(desiredServers).sort()) {
			if (Object.hasOwn(native.servers, serverName) && !managedServerNames.has(serverName)) {
				throw new Error(`refusing to replace unmanaged ${name} MCP server ${serverName}`);
			}
		}
		const mutations: HostedMcpMutation[] = [];
		const packages: BuiltinMcpPackage[] = [];
		for (const serverName of [...managedServerNames].sort()) {
			if (!Object.hasOwn(desiredServers, serverName) && Object.hasOwn(native.servers, serverName)) {
				mutations.push({ kind: "remove", serverName });
			}
		}
		for (const [serverName, desired] of Object.entries(desiredServers).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			let server: HostedMcpNativeServer = hostedMcpNativeServerConfig(serverName, desired);
			if (desired.localVault === 1) {
				const root =
					name === "openclaw"
						? openClawWorkspaceRoot
						: (manifest.workspaceRoot ?? paths.workspaceRoot);
				if (!root) throw new Error("Authenticated Agent workspace is unavailable for MCP.");
				const artifact = planBuiltinMcp(manifest, paths, desired, root);
				packages.push(artifact);
				server = artifact.server;
			}
			if (!canonicalJsonEqual(native.servers[serverName], server)) {
				mutations.push({ kind: "set", serverName, server });
			}
		}
		const hasSet = mutations.some((mutation) => mutation.kind === "set");
		if (hasSet && (!observation?.enabled || observation.status === "install_failed")) {
			throw new Error(`could not apply managed ${name} MCP servers: runtime is unavailable`);
		}
		return { name, native, mutations, commandPath, packages };
	});
	return { home, runtimes };
}
function hostedMcpNativeServerIsManaged(
	serverName: string,
	server: unknown,
	paths: RuntimePaths,
): boolean {
	if (
		serverName === "clawdi" &&
		isPlainRecord(server) &&
		server.command === "/usr/local/bin/node" &&
		Array.isArray(server.args)
	) {
		const [script, flag, config] = server.args;
		const root = join(dirname(paths.serviceStateRoot), "clawdi-mcp");
		if (
			server.args.length === 3 &&
			typeof script === "string" &&
			script.startsWith(`${root}/`) &&
			/^[a-f0-9]{64}\/index\.mjs$/.test(script.slice(root.length + 1)) &&
			flag === "--config" &&
			config === script.replace(/index\.mjs$/, "context.json")
		)
			return true;
	}
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
	serverName: string,
	desired: HostedMcpServerDesiredState,
): { url: string; transport: "streamable-http" | "sse"; headers: Record<string, string> } {
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
	hermesConfig: HermesConfigTransaction | null,
	openClawWorkspaceRoot: string | null = null,
): void {
	buildHostedMcpReconciliationPlan(
		manifest,
		paths,
		observations,
		hermesConfig,
		openClawWorkspaceRoot,
	);
}
