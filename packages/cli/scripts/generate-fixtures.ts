/**
 * Generate synthetic fixture HOME directories for the 4 agent adapters.
 *
 * Usage:  bun scripts/generate-fixtures.ts
 *
 * Output: packages/cli/tests/fixtures/{claude-code,codex,hermes,openclaw}/
 *
 * Run this ONCE (or whenever an adapter's expected input shape changes).
 * Generated files are committed; tests don't regenerate them at runtime.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "tests", "fixtures");

function ensureDir(p: string) {
	mkdirSync(p, { recursive: true });
}

function resetDir(p: string) {
	if (existsSync(p)) rmSync(p, { recursive: true, force: true });
	ensureDir(p);
}

function writeJson(p: string, data: unknown) {
	ensureDir(dirname(p));
	writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
}

function writeJsonl(p: string, lines: unknown[]) {
	ensureDir(dirname(p));
	writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function writeText(p: string, content: string) {
	ensureDir(dirname(p));
	writeFileSync(p, content);
}

// ─────────────────────────────────────────────────────────────
// Claude Code
//
// Layout:  $HOME/.claude/projects/<encoded-path>/<uuid>.jsonl
// The adapter needs >= 3 lines and >= 1 message with extractable text content.
// Timestamps drive startedAt/endedAt; cwd drives projectPath; assistant msg.model
// drives session model; message.usage accumulates tokens.
// ─────────────────────────────────────────────────────────────
function generateClaudeCode() {
	const root = join(fixturesRoot, "claude-code", ".claude");
	resetDir(join(fixturesRoot, "claude-code"));

	const projectDirName = "-Users-fixture-project";
	const sessionId = "11111111-2222-3333-4444-555555555555";
	const jsonlPath = join(root, "projects", projectDirName, `${sessionId}.jsonl`);

	const lines = [
		// Non-message entries: the adapter reads timestamp/cwd from any entry, not just messages.
		{
			type: "session-start",
			sessionId,
			cwd: "/Users/fixture/project",
			timestamp: "2026-04-20T10:00:00.000Z",
			version: "1.0.0",
		},
		{
			type: "user",
			sessionId,
			cwd: "/Users/fixture/project",
			timestamp: "2026-04-20T10:00:01.000Z",
			message: { role: "user", content: "hello" },
		},
		{
			type: "assistant",
			sessionId,
			timestamp: "2026-04-20T10:00:02.500Z",
			message: {
				role: "assistant",
				model: "claude-opus-4-7",
				content: [{ type: "text", text: "world" }],
				usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
			},
		},
		{
			type: "user",
			sessionId,
			timestamp: "2026-04-20T10:00:03.000Z",
			message: { role: "user", content: "one more" },
		},
		{
			type: "assistant",
			sessionId,
			timestamp: "2026-04-20T10:00:05.000Z",
			message: {
				role: "assistant",
				model: "claude-opus-4-7",
				content: [{ type: "text", text: "done" }],
				usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 5 },
			},
		},
	];
	writeJsonl(jsonlPath, lines);

	// A sample skill for collectSkills/writeSkillArchive assertions.
	writeText(
		join(root, "skills", "demo", "SKILL.md"),
		`---
name: demo
description: A demo skill
---

# demo

Demo content.
`,
	);

	// SKIP_DIRS sentinel — collectSkills must NOT surface this entry.
	// If it does, SKIP_DIRS wiring in the adapter has regressed.
	writeText(
		join(root, "skills", "node_modules", "SKILL.md"),
		`---
name: should-be-skipped
description: If this appears in test results, SKIP_DIRS is broken
---`,
	);
}

// ─────────────────────────────────────────────────────────────
// Codex
//
// Layout:  $HOME/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// Adapter expects:
//   - session_meta with payload.id (and payload.cwd for projectFilter)
//   - turn_context with payload.model
//   - response_item with payload.type="message" + role + content blocks
//   - (optional) event_msg with payload.type="token_count" for token counters
// ─────────────────────────────────────────────────────────────
function generateCodex() {
	const root = join(fixturesRoot, "codex", ".codex");
	resetDir(join(fixturesRoot, "codex"));

	const sessionId = "019ae46c-52d9-7e51-9527-1b105eb42d1b";
	const jsonlPath = join(
		root,
		"sessions",
		"2026",
		"04",
		"20",
		`rollout-2026-04-20T10-00-00-${sessionId}.jsonl`,
	);

	const lines = [
		{
			timestamp: "2026-04-20T10:00:00.000Z",
			type: "session_meta",
			payload: {
				id: sessionId,
				timestamp: "2026-04-20T10:00:00.000Z",
				cwd: "/Users/fixture/project",
				originator: "codex_cli_rs",
				cli_version: "0.63.0",
				instructions: "# Agents\n\nFixture instructions (placeholder).",
			},
		},
		{
			timestamp: "2026-04-20T10:00:01.000Z",
			type: "turn_context",
			payload: {
				model: "gpt-5.3-codex",
			},
		},
		{
			timestamp: "2026-04-20T10:00:02.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "hello" }],
			},
		},
		{
			timestamp: "2026-04-20T10:00:03.500Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "world" }],
			},
		},
		{
			timestamp: "2026-04-20T10:00:04.000Z",
			type: "event_msg",
			payload: {
				type: "token_count",
				info: {
					total_token_usage: {
						input_tokens: 15,
						output_tokens: 7,
						cached_input_tokens: 3,
					},
				},
			},
		},
	];
	writeJsonl(jsonlPath, lines);

	writeText(
		join(root, "skills", "demo", "SKILL.md"),
		`---
name: demo
description: A demo skill
---

# demo

Demo content.
`,
	);

	// .system/ must be skipped by Codex adapter (startsWith "." rule).
	writeText(
		join(root, "skills", ".system", "internal", "SKILL.md"),
		`---
name: hidden
description: should not appear
---`,
	);

	// SKIP_DIRS sentinel — parallel to the Claude Code fixture.
	writeText(
		join(root, "skills", "node_modules", "SKILL.md"),
		`---
name: should-be-skipped
description: If this appears in test results, SKIP_DIRS is broken
---`,
	);
}

// ─────────────────────────────────────────────────────────────
// Hermes
//
// Layout:  $HOME/.hermes/state.db (SQLite), $HOME/.hermes/skills/...
// Required tables (from HermesAdapter.collectSessions):
//   sessions(id, source, model, title, started_at, ended_at,
//            message_count, input_tokens, output_tokens, cache_read_tokens)
//   messages(session_id, role, content, timestamp)
// Timestamps stored as Unix epoch seconds.
// ─────────────────────────────────────────────────────────────
function generateHermes() {
	const root = join(fixturesRoot, "hermes", ".hermes");
	resetDir(join(fixturesRoot, "hermes"));
	ensureDir(root);

	const dbPath = join(root, "state.db");
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			source TEXT,
			model TEXT,
			title TEXT,
			started_at REAL NOT NULL,
			ended_at REAL,
			message_count INTEGER DEFAULT 0,
			input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			cache_read_tokens INTEGER DEFAULT 0
		);

		CREATE TABLE messages (
			session_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT,
			timestamp REAL NOT NULL,
			FOREIGN KEY(session_id) REFERENCES sessions(id)
		);
	`);

	// 2026-04-20 10:00:00 UTC in epoch seconds
	const t = 1776247200;

	// A plain-string model session.
	db.run(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
		"s-plain",
		"telegram",
		"claude-opus-4-7",
		"First chat",
		t,
		t + 5,
		2,
		10,
		5,
		2,
	]);
	db.run(`INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`, [
		"s-plain",
		"user",
		"hello",
		t,
	]);
	db.run(`INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`, [
		"s-plain",
		"assistant",
		"world",
		t + 2,
	]);

	// A JSON-blob model session (parseModelField path).
	db.run(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
		"s-json",
		"telegram",
		'{"default":"gpt-5.3-codex","provider":"openai-codex"}',
		"New Chat",
		t + 10,
		t + 20,
		2,
		8,
		4,
		0,
	]);
	db.run(`INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`, [
		"s-json",
		"user",
		"hi again",
		t + 10,
	]);
	db.run(`INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`, [
		"s-json",
		"assistant",
		"howdy",
		t + 15,
	]);

	// A session with no messages (adapter must skip it).
	db.run(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
		"s-empty",
		"telegram",
		"claude-opus-4-7",
		"Empty",
		t + 100,
		null,
		0,
		0,
		0,
		0,
	]);

	db.close();

	// Nested skill (Hermes supports skills/category/skill-name/SKILL.md).
	writeText(
		join(root, "skills", "core", "demo", "SKILL.md"),
		`---
name: demo
description: A nested demo skill
---

# demo

Demo content.
`,
	);

	// SKIP_DIRS sentinel — Hermes scans recursively; the skip must
	// apply at every recursion depth, not just the top level.
	writeText(
		join(root, "skills", "node_modules", "bad", "SKILL.md"),
		`---
name: should-be-skipped
description: If this appears in test results, SKIP_DIRS is broken
---`,
	);
}

// ─────────────────────────────────────────────────────────────
// OpenClaw
//
// Layout: $HOME/.openclaw/agents/<agentId>/sessions/sessions.json
//         $HOME/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
// The index maps sessionId → SessionEntry metadata; the transcript has
// type:"message" lines with message.role + message.content.
// ─────────────────────────────────────────────────────────────
function generateOpenClaw() {
	const root = join(fixturesRoot, "openclaw", ".openclaw", "agents", "main");
	resetDir(join(fixturesRoot, "openclaw"));
	ensureDir(root);

	const sessionId = "oc-session-001";
	const updatedAt = 1776247205_000; // ms

	const index = {
		[sessionId]: {
			sessionId,
			updatedAt,
			sessionFile: `${sessionId}.jsonl`,
			model: "claude-opus-4-7",
			modelProvider: "anthropic",
			inputTokens: 12,
			outputTokens: 6,
			totalTokens: 18,
			cacheRead: 2,
			cacheWrite: 0,
			displayName: "Fixture session",
			subject: null,
			label: null,
			acp: {
				cwd: "/Users/fixture/project",
				lastActivityAt: updatedAt,
			},
		},
	};
	writeJson(join(root, "sessions", "sessions.json"), index);

	const transcript = [
		{
			type: "message",
			timestamp: "2026-04-20T10:00:00.000Z",
			message: {
				role: "user",
				content: "hello",
			},
		},
		{
			type: "model_change",
			timestamp: "2026-04-20T10:00:01.000Z",
			modelId: "claude-opus-4-7",
		},
		{
			type: "message",
			timestamp: "2026-04-20T10:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "world" }],
			},
		},
	];
	writeJsonl(join(root, "sessions", `${sessionId}.jsonl`), transcript);

	writeText(
		join(root, "skills", "demo", "SKILL.md"),
		`---
name: demo
description: A demo skill
---

# demo

Demo content.
`,
	);

	// SKIP_DIRS sentinel.
	writeText(
		join(root, "skills", "node_modules", "SKILL.md"),
		`---
name: should-be-skipped
description: If this appears in test results, SKIP_DIRS is broken
---`,
	);
}

// ─────────────────────────────────────────────────────────────
console.log("Generating fixtures into", fixturesRoot);
generateClaudeCode();
console.log("  ✓ claude-code");
generateCodex();
console.log("  ✓ codex");
generateHermes();
console.log("  ✓ hermes");
generateOpenClaw();
console.log("  ✓ openclaw");
console.log("Done.");
