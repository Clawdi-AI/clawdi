import type { AgentType } from "./registry";

/**
 * One block inside a structured message. Canonical Anthropic-style shape so
 * the wire format is uniform across adapters even when the source agent
 * uses a different convention (camelCase toolCall, OpenAI function_call, etc.)
 * — adapters normalize on emit.
 *
 * `extra` fields (e.g. `signature` on thinking blocks, anything we haven't
 * modeled) are kept off this type intentionally; readers should tolerate
 * unknown keys and not rely on them.
 */
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| {
			type: "tool_result";
			tool_use_id: string;
			content: string;
			is_error?: boolean;
	  }
	| { type: "thinking"; thinking: string };

export interface SessionMessage {
	role: "user" | "assistant";
	/**
	 * Either a flat string (legacy / hermes) or a list of content blocks
	 * (claude_code / codex / openclaw — preserves tool_use + tool_result so
	 * downstream analytics can count and search tool calls).
	 *
	 * Empty messages are dropped at the adapter level; readers should treat
	 * `string` and `[{type:"text", text:"..."}]` as equivalent.
	 */
	content: string | ContentBlock[];
	model?: string;
	timestamp?: string;
}

/** Per-block cap on tool_result text. Beyond this we append a truncation
 * marker. Most useful tool outputs are well under 8KB; large dumps (file
 * reads, full bash output) get clipped to keep session uploads under
 * multipart-friendly sizes without losing the structural record of the
 * call. */
export const MAX_TOOL_OUTPUT_CHARS = 8000;

/** Truncate a tool-result string in place if it exceeds the cap. */
export function clampToolOutput(s: string): string {
	if (s.length <= MAX_TOOL_OUTPUT_CHARS) return s;
	return `${s.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[...truncated ${s.length - MAX_TOOL_OUTPUT_CHARS} chars]`;
}

/** When a normalized block list is text-only (no tool_use, no tool_result, no
 * thinking), collapse it to a plain string — matches the legacy wire format
 * for the common case of an assistant message with just prose, keeps payloads
 * smaller, and lets downstream readers that only handle strings keep working.
 *
 * Returns null if the blocks reduce to nothing (caller should drop the
 * message). */
export function collapseTextOnly(blocks: ContentBlock[]): string | ContentBlock[] | null {
	if (blocks.length === 0) return null;
	if (blocks.every((b) => b.type === "text")) {
		const joined = blocks.map((b) => (b as { text: string }).text).join("\n");
		return joined ? joined : null;
	}
	return blocks;
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
