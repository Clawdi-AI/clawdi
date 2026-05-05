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

	getSkillPath(key: string): string;
	writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void>;

	buildRunCommand(args: string[], env: Record<string, string>): string[];
}
