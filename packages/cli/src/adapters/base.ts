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

/**
 * Return shape of `AgentAdapter.collectSessions`.
 *
 * `dedupedCount` is non-zero only for `ClaudeCodeAdapter`, which dedupes
 * resume chains: when a newer session's message-uuid set strictly contains
 * an older one's, the older one is recognized as a resume predecessor and
 * dropped from the result. Other adapters return `dedupedCount: 0` because
 * their storage formats don't produce cross-file duplication (e.g. Codex
 * keeps long-conversation history in-file via `compacted` entries).
 */
export interface CollectSessionsResult {
	sessions: RawSession[];
	dedupedCount: number;
}

export interface RawSkill {
	skillKey: string;
	name: string;
	content: string;
	filePath: string;
	directoryPath: string;
	isDirectory: boolean;
	// Set by `push` during the scan phase — the skill folder hash used to
	// diff against the skills-lock. Adapters do not populate this.
	contentHash?: string;
}

export interface AgentAdapter {
	readonly agentType: AgentType;

	detect(): Promise<boolean>;
	getVersion(): Promise<string | null>;

	collectSessions(opts?: CollectSessionsOptions): Promise<CollectSessionsResult>;
	/**
	 * Re-read one session from its current backing store, when supported.
	 * Implementations must not return a cached transcript payload.
	 */
	collectSession?(localSessionId: string): Promise<RawSession | null>;
	/**
	 * Parse only sessions represented by concrete watcher paths.
	 *
	 * Returns `null` when any path cannot be resolved safely to a bounded
	 * session set. The daemon then falls back to `collectSessions()`. The
	 * result is a partial inventory, so callers must not infer deletion of
	 * sessions omitted from it.
	 */
	collectSessionsForPaths?(
		paths: readonly string[],
		opts?: CollectSessionsOptions,
	): Promise<CollectSessionsResult | null>;
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
	 * `clawdi daemon` watches this for change events. Distinct from
	 * `getSkillPath(key)` which points at the SKILL.md inside one
	 * skill — empty-key callers were getting `<root>/skills//SKILL.md`
	 * before this method existed. */
	getSkillsRootDir(): string;
	/** Returns the on-disk path where a SHARED-PROJECT skill should
	 * land. The owner-handle (resolved server-side, frozen at link
	 * create for each shared owner) is appended with `__` separator so
	 * the same key from different owners coexists with the recipient's
	 * own key.
	 *
	 * Example for Claude Code:
	 *   getSharedSkillPath("git-tools", "alice-a3b4")
	 *     → "~/.claude/skills/git-tools__alice-a3b4"
	 *
	 * Personal project skills keep using `getSkillsRootDir() + key`
	 * with no suffix. */
	getSharedSkillPath(skillKey: string, ownerHandle: string): string;
	/** Path(s) `clawdi daemon` should watch for session changes. May
	 * be directories (Claude Code, Codex, OpenClaw all dump JSONL
	 * files there) or database/sidecar files (Hermes uses SQLite). The
	 * daemon passes concrete changed paths to `collectSessionsForPaths`
	 * when the platform provides them, with `collectSessions` as the safe
	 * fallback for ambiguous events and shared data stores.
	 *
	 * Returning paths that don't exist yet is fine — the watcher
	 * skips missing roots and reattaches when `mkdir` lands. The
	 * daemon does NOT throw on a missing path because the agent
	 * may simply have never run yet. */
	getSessionsWatchPaths(): string[];
	writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void>;
	/** Like `writeSkillArchive` but lands the content at the shared-
	 * project path (`getSharedSkillPath(key, ownerHandle)`) rather than
	 * `getSkillsRootDir() + key`. Tarball still has `<key>/...` as its
	 * top-level layout (uploads don't know they'll be re-served as
	 * shared); implementations extract into a temp dir and rename
	 * the top entry to `<key>__<ownerHandle>`.
	 *
	 * Called by explicit pull flows so the recipient's agent sees the
	 * shared skill folder only after content download is requested. */
	writeSharedSkillArchive(key: string, ownerHandle: string, tarGzBytes: Buffer): Promise<void>;
	/** Remove a Skill from the Agent's local skills directory. Callers must
	 * prove exact local ownership before invoking this method; Project desired-
	 * inventory reconciliation does so with its durable materialization receipt.
	 * An already absent target is handled idempotently. */
	removeLocalSkill(key: string): Promise<void>;

	buildRunCommand(args: string[], env: Record<string, string>): string[];
}
