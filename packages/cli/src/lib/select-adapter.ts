import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { AgentAdapter } from "../adapters/base";
import {
	AGENT_TYPES,
	type AgentType,
	adapterRegistry,
	allAdapterEntries,
	getAdapterEntry,
} from "../adapters/registry";
import { getClawdiDir } from "./config";
import { askOne } from "./prompts";
import { isInteractive } from "./tty";

export function getEnvIdByAgent(agentType: string): string | null {
	const envPath = join(getClawdiDir(), "environments", `${agentType}.json`);
	if (!existsSync(envPath)) return null;
	return JSON.parse(readFileSync(envPath, "utf-8")).id;
}

/** Ask the cloud which scope this caller's next write would land
 * in. Wraps the server-side `resolve_default_write_scope` logic
 * exposed by `GET /api/scopes/default` — for an api_key bound to
 * an env, that's the env's `default_scope_id`; for a Clerk JWT
 * (rare in CLI use) it's the most-recently-active env's scope or
 * Personal as a fallback.
 *
 * Phase-2 scope-explicit URLs (e.g. `/api/scopes/{scope_id}/skills/upload`)
 * need a scope_id in the path. Calling this once at command start
 * lets the CLI not have to track env_id locally.
 *
 * NOTE: when the caller already knows which env's scope it wants
 * (e.g. multi-agent push: each agent has its own envId), prefer
 * `fetchScopeIdForEnv()` below. The default-scope endpoint picks
 * "most recently active" on unbound keys, which can route a
 * `claude_code` push under the user's `codex` env if codex was
 * touched last — sessions write to envId, skills write to "the
 * other env's scope", and the `claude_code` daemon never sees
 * the skills it just pushed.
 */
export async function fetchDefaultScopeId(api: import("./api-client").ApiClient): Promise<string> {
	const { unwrap } = await import("./api-client");
	const res = unwrap(await api.GET("/api/scopes/default"));
	return res.scope_id;
}

/** Resolve the default_scope_id of a specific env. The caller
 * already knows which env it wants to write to (via
 * `getEnvIdByAgent(agentType)`); this just round-trips the
 * env detail to read its `default_scope_id`.
 *
 * Use this anywhere the CLI is operating on a known agent: the
 * agent's `envId` is the source of truth, not the auth key's
 * "most recently active" heuristic. Multi-agent users on a
 * normal unbound CLI key would otherwise see skills land under
 * the wrong scope while sessions write correctly to their own
 * envId — the daemon serving that env never reconciles those
 * skills back to disk because the listing is scoped elsewhere.
 */
export async function fetchScopeIdForEnv(
	api: import("./api-client").ApiClient,
	envId: string,
): Promise<string> {
	const { unwrap } = await import("./api-client");
	const env = unwrap(
		await api.GET("/api/environments/{environment_id}", {
			params: { path: { environment_id: envId } },
		}),
	);
	return env.default_scope_id;
}

export function adapterForType(agentType: AgentType): AgentAdapter | null {
	const entry = getAdapterEntry(agentType);
	return entry ? entry.create() : null;
}

export function listRegisteredAgentTypes(): AgentType[] {
	const envDir = join(getClawdiDir(), "environments");
	if (!existsSync(envDir)) return [];
	const types: AgentType[] = [];
	const files = new Set(readdirSync(envDir));
	for (const entry of allAdapterEntries()) {
		if (files.has(entry.envFileName)) types.push(entry.agentType);
	}
	return types;
}

/**
 * Resolve the agent adapter to operate on. Prints a specific error message
 * to stdout before returning null so callers can simply abort — distinguishing
 * "no agents found" from "ambiguous, can't pick without a prompt" is critical
 * in non-interactive contexts (CI, AI agents, piped stdout) where the user
 * sees a misleading "no supported agent" message if we collapse the cases.
 */
export async function selectAdapter(agentOpt?: string): Promise<AgentAdapter | null> {
	// 1. Explicit --agent wins.
	if (agentOpt) {
		if (!AGENT_TYPES.includes(agentOpt as AgentType)) {
			console.log(chalk.red(`Unknown agent type: ${agentOpt}`));
			console.log(chalk.gray(`Valid types: ${AGENT_TYPES.join(", ")}`));
			return null;
		}
		const adapter = adapterForType(agentOpt as AgentType);
		if (!adapter) {
			console.log(chalk.red(`Agent ${agentOpt} has no adapter implementation.`));
			return null;
		}
		return adapter;
	}

	// 2. Prefer registered environments.
	const registered = listRegisteredAgentTypes();
	if (registered.length === 1 && registered[0]) return adapterForType(registered[0]);
	if (registered.length > 1) {
		if (!isInteractive()) {
			console.log(chalk.red("Multiple agents are registered on this machine."));
			console.log(
				chalk.gray(`Pass --agent <type> to choose one. Registered: ${registered.join(", ")}`),
			);
			return null;
		}
		const picked = await askOne<AgentType>(
			"Multiple agents registered. Select one:",
			registered.map((t) => ({ value: t, label: adapterRegistry[t].displayName })),
		);
		return picked ? adapterForType(picked) : null;
	}

	// 3. Fall back to detection.
	const allAdapters = allAdapterEntries().map((e) => e.create());
	const detected = (
		await Promise.all(allAdapters.map(async (a) => ((await a.detect()) ? a : null)))
	).filter((a): a is AgentAdapter => a !== null);
	if (detected.length === 0) {
		console.log(chalk.red("No supported agent detected on this machine."));
		console.log(
			chalk.gray(`Install one or pass --agent <type>. Available types: ${AGENT_TYPES.join(", ")}`),
		);
		return null;
	}
	if (detected.length === 1 && detected[0]) return detected[0];
	if (!isInteractive()) {
		const types = detected.map((a) => a.agentType);
		console.log(chalk.red("Multiple agents detected on this machine."));
		console.log(chalk.gray(`Pass --agent <type> to choose one. Detected: ${types.join(", ")}`));
		return null;
	}
	const picked = await askOne<AgentType>(
		"Multiple agents detected. Select one:",
		detected.map((a) => ({
			value: a.agentType,
			label: adapterRegistry[a.agentType].displayName,
		})),
	);
	return picked ? adapterForType(picked) : null;
}

/**
 * Resolve a list of agent targets for commands that operate across multiple
 * agents at once (`push --all-agents`, `session list --all-agents`).
 *
 * Returns the empty array when the caller should abort — same convention as
 * `selectAdapter`. The caller has already printed an explanatory message in
 * the failure cases this function handles.
 *
 *   --all-agents          → every type with a file under ~/.clawdi/environments/
 *   --agent <type>        → exactly that one (validated)
 *   neither, single match → the single registered/detected adapter (via selectAdapter)
 *   neither, ambiguous    → null in non-interactive contexts; prompt otherwise
 */
export async function resolveTargetAgentTypes(
	agentOpt: string | undefined,
	allAgents: boolean,
): Promise<AgentType[]> {
	if (agentOpt && allAgents) {
		console.log(chalk.red("Pass either --agent or --all-agents, not both."));
		return [];
	}

	if (allAgents) {
		const registered = listRegisteredAgentTypes();
		if (registered.length === 0) {
			console.log(chalk.red("No agents are registered on this machine."));
			console.log(chalk.gray("Run `clawdi setup` first."));
			return [];
		}
		return registered;
	}

	const adapter = await selectAdapter(agentOpt);
	return adapter ? [adapter.agentType] : [];
}
