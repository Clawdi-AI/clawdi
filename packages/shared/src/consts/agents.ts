export const AGENT_TYPES = ["claude_code", "codex", "openclaw", "hermes"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_LABELS: Record<AgentType, string> = {
	claude_code: "Claude Code",
	codex: "Codex",
	openclaw: "OpenClaw",
	hermes: "Hermes",
};
