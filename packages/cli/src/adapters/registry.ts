import { join } from "node:path";
import type { AgentAdapter } from "./base";
import { ClaudeCodeAdapter } from "./claude-code";
import { CodexAdapter } from "./codex";
import { HermesAdapter } from "./hermes";
import { OpenClawAdapter } from "./openclaw";
import { getClaudeHome, getCodexHome, getHermesHome, getOpenClawHome } from "./paths";

// Re-exported here for callers that think of SKIP_DIRS as a registry concern.
// Defined in paths.ts to avoid a circular import (registry imports adapters).
export { SKIP_DIRS } from "./paths";

// Agent identity is declared as a literal tuple so `AgentType` doesn't depend
// on the registry object — avoids a type-level cycle when `AdapterRegistryEntry`
// references `AgentAdapter` (which references `AgentType`).
// Adding an agent: append here AND add the matching entry to `adapterRegistry`.
export const AGENT_TYPES = ["claude_code", "codex", "openclaw", "hermes"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

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
	return (Object.keys(adapterRegistry) as AgentType[]).map((agentType) => ({
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
export function builtinSkillTargetDir(agentType: AgentType): string | null {
	const home = adapterRegistry[agentType]?.home();
	if (!home) return null;
	if (agentType === "openclaw") {
		const openclawAgentId = process.env.OPENCLAW_AGENT_ID || "main";
		return join(home, "agents", openclawAgentId, "skills", "clawdi");
	}
	if (agentType === "claude_code" || agentType === "codex" || agentType === "hermes") {
		return join(home, "skills", "clawdi");
	}
	return null;
}
