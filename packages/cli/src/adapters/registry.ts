import { join } from "node:path";
import { AGENT_TYPES, type AgentType } from "./agent-types";
import type { AgentAdapter } from "./base";
import { ClaudeCodeAdapter } from "./claude-code";
import { CodexAdapter } from "./codex";
import { HermesAdapter } from "./hermes";
import { OpenClawAdapter } from "./openclaw";
import { resolveOpenClawAgentWorkspace } from "./openclaw-workspace";
import { getClaudeHome, getCodexHome, getHermesHome, getOpenClawHome } from "./paths";

export { AGENT_TYPES, type AgentType } from "./agent-types";

export interface AdapterRegistryEntry {
	displayName: string;
	/** File name stored under `~/.clawdi/environments/` when the agent is registered. */
	envFileName: string;
	/** Lazy home-dir resolver (honors env overrides, probes fallback paths). */
	home: () => string;
	/** Construct an adapter instance. */
	create: () => AgentAdapter;
}

// Registry: every `AgentType` must have exactly one entry — `Record<AgentType, …>`
// enforces exhaustiveness at compile time.
export const adapterRegistry: Record<AgentType, AdapterRegistryEntry> = {
	claude_code: {
		displayName: "Claude Code",
		envFileName: "claude_code.json",
		home: getClaudeHome,
		create: () => new ClaudeCodeAdapter(),
	},
	codex: {
		displayName: "Codex",
		envFileName: "codex.json",
		home: getCodexHome,
		create: () => new CodexAdapter(),
	},
	openclaw: {
		displayName: "OpenClaw",
		envFileName: "openclaw.json",
		home: getOpenClawHome,
		create: () => new OpenClawAdapter(),
	},
	hermes: {
		displayName: "Hermes",
		envFileName: "hermes.json",
		home: getHermesHome,
		create: () => new HermesAdapter(),
	},
};

/** Registry entry annotated with its agent type — convenience for iteration. */
export interface AnnotatedAdapterEntry extends AdapterRegistryEntry {
	agentType: AgentType;
}

export function allAdapterEntries(): AnnotatedAdapterEntry[] {
	return AGENT_TYPES.map((agentType) => ({
		agentType,
		...adapterRegistry[agentType],
	}));
}

export function getAdapterEntry(type: AgentType): AdapterRegistryEntry | null {
	return adapterRegistry[type] ?? null;
}

/**
 * Where the bundled `clawdi` skill lives inside an agent's home.
 * Both `setup` (write) and `teardown` (delete) use this so the two
 * commands can never disagree about the path.
 */
export function builtinSkillTargetDir(agentType: AgentType, homeOverride?: string): string | null {
	return agentSkillTargetDir(agentType, "clawdi", homeOverride);
}

export function agentSkillTargetDir(
	agentType: AgentType,
	skillName: string,
	homeOverride?: string,
): string | null {
	const home = homeOverride ?? adapterRegistry[agentType]?.home();
	if (!home) return null;
	if (agentType === "openclaw") {
		return join(resolveOpenClawAgentWorkspace(), "skills", skillName);
	}
	if (agentType === "claude_code" || agentType === "codex" || agentType === "hermes") {
		return join(home, "skills", skillName);
	}
	return null;
}
