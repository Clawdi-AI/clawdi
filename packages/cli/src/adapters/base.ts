import type { AgentType } from "./registry";

export interface SessionMessage {
	role: "user" | "assistant";
	content: string;
	model?: string;
	timestamp?: string;
}

export interface RawSession {
	localSessionId: string;
	projectPath: string | null;
	startedAt: Date;
	endedAt: Date | null;
	messageCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	model: string | null;
	modelsUsed: string[];
	durationSeconds: number | null;
	summary: string | null;
	messages: SessionMessage[];
	rawFilePath: string;
	// Set by `pushOneAgent` after collection — sha256 hex of the JSON
	// the CLI is about to upload. Adapters do not populate this.
	contentHash?: string;
}

/**
 * Options for `AgentAdapter.collectSessions`.
 *
 * `projectFilter` restricts to sessions whose stored `cwd` / project path
 * equals or is under the given absolute path. Hermes ignores this — its
 * data model has no project linkage.
 *
 * Adapters always do a full scan and return every session that matches
 * the project filter. Whether to actually push a session to the server
 * is decided in `pushOneAgent` against `~/.clawdi/sessions-lock.json`.
 */
export interface CollectSessionsOptions {
	projectFilter?: string;
}

export interface RawSkill {
	skillKey: string;
	name: string;
	content: string;
	filePath: string;
	directoryPath: string;
	isDirectory: boolean;
}

export interface AgentAdapter {
	readonly agentType: AgentType;

	detect(): Promise<boolean>;
	getVersion(): Promise<string | null>;

	collectSessions(opts?: CollectSessionsOptions): Promise<RawSession[]>;
	collectSkills(): Promise<RawSkill[]>;
	/** Enumerate skill_keys present on disk WITHOUT reading SKILL.md
	 * content. Used by the daemon's hot-path rescan / boot listing
	 * to diff against `lastPushedHash` cheaply.
	 *
	 * Returns relative paths in the same shape `collectSkills`
	 * would emit `skillKey` — flat for Claude Code / Codex /
	 * OpenClaw, nested (`category/foo`) for Hermes. The daemon
	 * uses these as path components under
	 * `getSkillsRootDir()` for hash + watch + push, so nested
	 * shapes only land here when the adapter actually supports
	 * nested layouts on disk. */
	listSkillKeys(): Promise<string[]>;

	getSkillPath(key: string): string;
	/** Directory containing one subdirectory per skill_key.
	 * `clawdi serve` watches this for change events. Distinct from
	 * `getSkillPath(key)` which points at the SKILL.md inside one
	 * skill — empty-key callers were getting `<root>/skills//SKILL.md`
	 * before this method existed. */
	getSkillsRootDir(): string;
	/** Path(s) `clawdi serve` should watch for session changes. May
	 * be directories (Claude Code, Codex, OpenClaw all dump JSONL
	 * files there) or a single file (Hermes uses a SQLite DB). The
	 * daemon walks each path on a change event, then runs
	 * `collectSessions` to enumerate what's actually there.
	 *
	 * Returning paths that don't exist yet is fine — the watcher
	 * skips missing roots and reattaches when `mkdir` lands. The
	 * daemon does NOT throw on a missing path because the agent
	 * may simply have never run yet. */
	getSessionsWatchPaths(): string[];
	writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void>;
	/** Remove a skill from the agent's local skills directory.
	 * Called by the daemon's reconcile sweep when a previously-
	 * observed cloud skill is no longer in the listing (dashboard
	 * uninstall, or a CLI delete on another machine). Idempotent
	 * — silently ignores a skill that's already gone. */
	removeLocalSkill(key: string): Promise<void>;

	buildRunCommand(args: string[], env: Record<string, string>): string[];
}
