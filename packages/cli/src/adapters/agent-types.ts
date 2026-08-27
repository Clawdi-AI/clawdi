/** Canonical agent identities supported by the CLI. */
export const AGENT_TYPES = [
	"claude_code",
	"codex",
	"openclaw",
	"hermes",
	"pi",
	"opencode",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];
