import { join } from "node:path";
import { AGENT_LABELS, type AgentType } from "@clawdi-cloud/shared/consts";
import type { AgentAdapter } from "./base";
import { ClaudeCodeAdapter } from "./claude-code";
import { CodexAdapter } from "./codex";
import { HermesAdapter } from "./hermes";
import { OpenClawAdapter } from "./openclaw";
import { getClaudeHome, getCodexHome, getHermesHome, getOpenClawHome } from "./paths";

// Re-exported here for callers that think of SKIP_DIRS as a registry concern.
// Defined in paths.ts to avoid a circular import (registry imports adapters).
export { SKIP_DIRS } from "./paths";

export interface AdapterRegistryEntry {
	agentType: AgentType;
	displayName: string;
	/** File name stored under `~/.clawdi/environments/` when the agent is registered. */
	envFileName: string;
	/** Lazy home-dir resolver (honors env overrides, probes fallback paths). */
	home: () => string;
	/** Construct an adapter instance. */
	create: () => AgentAdapter;
}

export const adapterRegistry: Record<AgentType, AdapterRegistryEntry> = {
	claude_code: {
		agentType: "claude_code",
		displayName: AGENT_LABELS.claude_code,
		envFileName: "claude_code.json",
		home: getClaudeHome,
		create: () => new ClaudeCodeAdapter(),
	},
	codex: {
		agentType: "codex",
		displayName: AGENT_LABELS.codex,
		envFileName: "codex.json",
		home: getCodexHome,
		create: () => new CodexAdapter(),
	},
	hermes: {
		agentType: "hermes",
		displayName: AGENT_LABELS.hermes,
		envFileName: "hermes.json",
		home: getHermesHome,
		create: () => new HermesAdapter(),
	},
	openclaw: {
		agentType: "openclaw",
		displayName: AGENT_LABELS.openclaw,
		envFileName: "openclaw.json",
		home: getOpenClawHome,
		create: () => new OpenClawAdapter(),
	},
};

export function allAdapterEntries(): AdapterRegistryEntry[] {
	return Object.values(adapterRegistry);
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
