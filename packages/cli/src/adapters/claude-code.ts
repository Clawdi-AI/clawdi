import type { AgentAdapter, RawSession, RawSkill } from "./base";

export class ClaudeCodeAdapter implements AgentAdapter {
	readonly agentType = "claude_code" as const;

	async detect(): Promise<boolean> {
		// Check if ~/.claude/ exists
		const { existsSync } = await import("node:fs");
		const { homedir } = await import("node:os");
		return existsSync(`${homedir()}/.claude`);
	}

	async getVersion(): Promise<string | null> {
		// TODO: run `claude --version` and parse
		return null;
	}

	async collectSessions(since?: Date): Promise<RawSession[]> {
		// TODO: scan ~/.claude/projects/*/*.jsonl, parse metadata
		return [];
	}

	async collectSkills(): Promise<RawSkill[]> {
		// TODO: scan ~/.claude/skills/
		return [];
	}

	async writeSkill(key: string, content: string): Promise<void> {
		// TODO: write to ~/.clawdi/skills/{key}.md
	}

	buildRunCommand(args: string[], env: Record<string, string>): string[] {
		return ["claude", ...args];
	}
}
