import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { AgentAdapter } from "../adapters/base";
import {
	AGENT_TYPES,
	type AgentType,
	allAdapterEntries,
	getAdapterEntry,
} from "../adapters/registry";
import { getClawdiDir } from "./config";

export function getEnvIdByAgent(agentType: string): string | null {
	const envPath = join(getClawdiDir(), "environments", `${agentType}.json`);
	if (!existsSync(envPath)) return null;
	return JSON.parse(readFileSync(envPath, "utf-8")).id;
}

/** Ask the cloud which project this caller's next write would land
 * in. Wraps the server-side `resolve_default_write_project` logic
 * exposed by `GET /api/projects/default` — for an api_key bound to
 * an env, that's the env's `default_project_id`; for a Clerk JWT
 * (rare in CLI use) it's the most-recently-active env's project or
 * Personal as a fallback.
 *
 * Phase-2 project-explicit URLs (e.g. `/api/projects/{project_id}/skills/upload`)
 * need a project_id in the path. Calling this once at command start
 * lets the CLI not have to track env_id locally.
 *
 * NOTE: when the caller already knows which env's project it wants
 * (e.g. multi-agent push: each agent has its own envId), prefer
 * `fetchProjectIdForEnv()` below. The default-project endpoint picks
 * "most recently active" on unbound keys, which can route a
 * `claude_code` push under the user's `codex` env if codex was
 * touched last — sessions write to envId, skills write to "the
 * other env's project", and the `claude_code` daemon never sees
 * the skills it just pushed.
 */
export async function fetchDefaultProjectId(
	api: import("./api-client").ApiClient,
): Promise<string> {
	const baseUrl = api.baseUrl;
	const headers: Record<string, string> = {};
	if (api.apiKey) headers.Authorization = `Bearer ${api.apiKey}`;

	const projectRes = await fetch(`${baseUrl}/api/projects/default`, { headers });
	if (projectRes.ok) {
		const body = (await projectRes.json()) as { project_id: string };
		return body.project_id;
	}

	const legacyBody = (await projectRes.json()) as { project_id?: string };
	if (legacyBody.project_id) return legacyBody.project_id;
	throw new Error("Failed to resolve default project: missing project_id in response");
}

/** Resolve the default project_id of a specific env. The caller
 * already knows which env it wants to write to (via
 * `getEnvIdByAgent(agentType)`); this just round-trips the
 * env detail to read its `default_project_id`.
 *
 * Use this anywhere the CLI is operating on a known agent: the
 * agent's `envId` is the source of truth, not the auth key's
 * "most recently active" heuristic. Multi-agent users on a
 * normal unbound CLI key would otherwise see skills land under
 * the wrong project while sessions write correctly to their own
 * envId — the daemon serving that env never reconciles those
 * skills back to disk because the listing targets another project.
 */
export async function fetchProjectIdForEnv(
	api: import("./api-client").ApiClient,
	envId: string,
): Promise<string> {
	const { unwrap } = await import("./api-client");
	const env = unwrap(
		await api.GET("/api/environments/{environment_id}", {
			params: { path: { environment_id: envId } },
		}),
	);
	const legacy = env as { default_project_id?: string };
	const projectId = env.default_project_id ?? legacy.default_project_id;
	if (!projectId) {
		throw new Error(`environment ${envId} has no default project id`);
	}
	return projectId;
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
 * Resolve a SINGLE agent adapter to operate on. Prints a specific error
 * message before returning null so callers can simply abort. Never
 * prompts — an ambiguous machine (multiple registered, or multiple
 * detected but none registered) aborts with instructions, identically
 * in TTY and non-TTY, so agent harnesses never stall on a picker.
 *
 * Multi-agent commands (`push`, `pull`, `session list`) should call
 * `resolveTargetAgentTypes` instead — it defaults an ambiguous machine
 * to "all registered agents" rather than aborting.
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
		// Multi-agent ambiguity is handled by `resolveTargetAgentTypes`
		// (it defaults to all registered agents). Single-target callers
		// via this path have no good "pick all" semantics, so keep the
		// abort here — but match TTY and non-TTY so agent harnesses get
		// the same message regardless of how they're run.
		console.log(chalk.red("Multiple agents are registered on this machine."));
		console.log(
			chalk.gray(`Pass --agent <type> to choose one. Registered: ${registered.join(", ")}`),
		);
		return null;
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
	// Multiple detected but none registered: this is a one-time
	// "which agent gets paired with my Clawdi account?" decision the
	// user must make via `clawdi setup`, not something to prompt for
	// at push/pull time. Same abort message in TTY and non-TTY so
	// agent harnesses see the path forward instead of a stalled prompt.
	const types = detected.map((a) => a.agentType);
	console.log(chalk.red("Multiple agents detected on this machine."));
	console.log(
		chalk.gray(
			`Run \`clawdi setup\` to register one, or pass --agent <type>. Detected: ${types.join(", ")}`,
		),
	);
	return null;
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
 *   neither, multi match  → every registered agent (the flagless default)
 *   neither, none usable  → empty array (selectAdapter printed the reason)
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

	// No --agent and no --all-agents: with multiple registered, default
	// to all of them. Today's behavior was to prompt in TTY (blocking
	// agent harnesses) or abort in CI; the new default matches the "do
	// the obvious thing" intent of a flagless invocation and keeps
	// all-agents users from having to type --all-agents every time.
	// Callers render their own per-agent output (push's combined scan
	// summary, pull's per-agent steps), so no notice is printed here.
	// Single-registered users hit the standard selectAdapter path below
	// and see no change.
	if (!agentOpt) {
		const registered = listRegisteredAgentTypes();
		if (registered.length > 1) {
			return registered;
		}
	}

	const adapter = await selectAdapter(agentOpt);
	return adapter ? [adapter.agentType] : [];
}
