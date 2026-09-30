import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentAdapterCore } from "../../../src/adapters/base";
import { ClaudeCodeAdapter } from "../../../src/adapters/claude-code";
import { CodexAdapter } from "../../../src/adapters/codex";
import { HermesAdapter } from "../../../src/adapters/hermes";
import { OpenClawAdapter } from "../../../src/adapters/openclaw";
import { OpenCodeAdapter } from "../../../src/adapters/opencode";
import { PiAdapter } from "../../../src/adapters/pi";
import { ApiClient } from "../../../src/lib/api-client";
import { EMPTY_EVENT_HEAD } from "../../../src/lib/session-events";
import {
	prepareSessionUpload,
	sessionFence,
	syncSessionContent,
} from "../../../src/lib/session-upload";

const root = process.env.CLAWDI_MEMORY_FIXTURE_ROOT;
if (!root) throw new Error("CLAWDI_MEMORY_FIXTURE_ROOT is required");
process.env.HOME = join(root, "home");
process.env.HERMES_HOME = join(root, "hermes");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.HERMES_HOME, { recursive: true });
const path = join(process.env.HERMES_HOME, "state.db");
const count = 114_507;
const selected =
	process.argv.find((value) => value.startsWith("--adapter="))?.slice(10) ?? "hermes";
const adapter: AgentAdapterCore = (() => {
	switch (selected) {
		case "claude_code":
			return new ClaudeCodeAdapter();
		case "codex":
			return new CodexAdapter();
		case "pi":
			return new PiAdapter();
		case "opencode":
			return new OpenCodeAdapter();
		case "openclaw":
			return new OpenClawAdapter();
		case "hermes":
			return new HermesAdapter();
		default:
			throw new Error("unsupported memory fixture adapter");
	}
})();
process.env.OPENCODE_DB = join(root, "opencode.db");
process.env.OPENCLAW_STATE_DIR = join(process.env.HOME, ".openclaw");
process.env.PATH = "/nonexistent";

function seedJsonl(): void {
	const file =
		selected === "claude_code"
			? join(process.env.HOME ?? "", ".claude", "projects", "-workspace", "large.jsonl")
			: selected === "codex"
				? join(process.env.HOME ?? "", ".codex", "sessions", "rollout-large.jsonl")
				: selected === "pi"
					? join(process.env.HOME ?? "", ".pi", "agent", "sessions", "large.jsonl")
					: join(process.env.OPENCLAW_STATE_DIR ?? "", "agents", "main", "sessions", "large.jsonl");
	mkdirSync(dirname(file), { recursive: true });
	if (selected === "openclaw")
		writeFileSync(
			join(dirname(file), "sessions.json"),
			JSON.stringify({
				"agent:main:main": {
					sessionId: "large",
					updatedAt: 1776247000000,
					sessionFile: "large.jsonl",
				},
			}),
		);
	const fd = openSync(file, "w");
	try {
		const line = (value: unknown) => writeSync(fd, `${JSON.stringify(value)}\n`);
		if (selected === "codex")
			line({
				type: "session_meta",
				payload: { id: "large", cwd: "/workspace", timestamp: "2026-04-15T12:00:00Z" },
			});
		if (selected === "pi")
			line({
				type: "session",
				version: 3,
				id: "large",
				cwd: "/workspace",
				timestamp: "2026-04-15T12:00:00Z",
			});
		for (let index = 0; index < count; index++) {
			const text = `${index}:${"x".repeat(6144)}`;
			const timestamp = new Date(1776247000000 + index).toISOString();
			if (selected === "codex")
				line({
					type: "response_item",
					timestamp,
					payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
				});
			else if (selected === "claude_code")
				line({
					type: "user",
					sessionId: "large",
					cwd: "/workspace",
					uuid: `row-${index}`,
					timestamp,
					message: { role: "user", content: text },
				});
			else
				line({
					type: "message",
					id: `row-${index}`,
					parentId: index ? `row-${index - 1}` : null,
					timestamp,
					message: { role: "user", content: [{ type: "text", text }] },
				});
		}
	} finally {
		closeSync(fd);
	}
}

function seedOpenCode(): void {
	const db = new Database(process.env.OPENCODE_DB ?? "", { create: true });
	try {
		db.exec(`
			CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT,
			tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER,
			tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
			model TEXT, agent TEXT);
			CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
			CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
			CREATE INDEX message_session ON message(session_id, time_created, id);
			CREATE INDEX part_message ON part(session_id, message_id, time_created, id);
			INSERT INTO session VALUES ('large', '/workspace', 'Memory fixture', '1.0', 0, 0, 0, 0, 0, 1776247000000, 1776248000000, NULL, NULL, NULL);
		`);
		const message = db.prepare("INSERT INTO message VALUES (?, 'large', ?, ?, ?)");
		const part = db.prepare("INSERT INTO part VALUES (?, ?, 'large', ?, ?, ?)");
		db.transaction(() => {
			for (let index = 0; index < count; index++) {
				const id = `${index}`.padStart(8, "0");
				const at = 1776247000000 + index;
				message.run(id, at, at, JSON.stringify({ role: "user" }));
				part.run(
					id,
					id,
					at,
					at,
					JSON.stringify({ type: "text", text: `${index}:${"x".repeat(6144)}` }),
				);
			}
		})();
	} finally {
		db.close();
	}
}

if (process.argv.includes("--seed")) {
	if (selected !== "hermes") {
		if (selected === "opencode") seedOpenCode();
		else seedJsonl();
		console.log(JSON.stringify({ adapter: selected, seeded: count }));
		process.exit(0);
	}
	const db = new Database(path, { create: true });
	try {
		db.exec(`
			CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT,
			started_at REAL, ended_at REAL, message_count INTEGER, input_tokens INTEGER,
			output_tokens INTEGER, cache_read_tokens INTEGER);
			CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,
			content TEXT, timestamp REAL);
			CREATE INDEX messages_session ON messages(session_id, id);
			INSERT INTO sessions VALUES ('large', 'discord', 'fixture-model', NULL,
			1776247000, NULL, 1166, 0, 0, 0);
		`);
		const insert = db.prepare(
			"INSERT INTO messages (session_id, role, content, timestamp) VALUES ('large', 'user', ?, ?)",
		);
		db.transaction(() => {
			for (let index = 0; index < count; index++)
				insert.run(`${index}:${"x".repeat(6144)}`, 1776247000 + index);
		})();
	} finally {
		db.close();
	}
	console.log(JSON.stringify({ seeded: count }));
} else {
	const localSessionId =
		selected === "pi" || selected === "opencode" ? `${selected}.large` : "large";
	const session = await adapter.sessions?.resolve(localSessionId, {
		streaming: true,
		signal: new AbortController().signal,
	});
	if (!session) throw new Error("fixture session is missing");
	const plan = await prepareSessionUpload(session, "events-v1");
	const api = new ApiClient({ baseUrl: "http://memory.test", requireAuth: false });
	let received = 0;
	let chunks = 0;
	let head = EMPTY_EVENT_HEAD;
	let generation = "";
	api.getSessionUploadCapabilities = async () => ({
		protocols: ["events-v1"],
		event_chunk_target_bytes: 4 * 1024 * 1024,
		event_chunk_max_bytes: 8 * 1024 * 1024,
	});
	api.getSessionEventHead = async () => ({
		protocol: "events-v1",
		generation: null,
		revision: 0,
		count: 0,
		head_hash: EMPTY_EVENT_HEAD,
	});
	api.stageSessionEventGeneration = async (_id, body) => {
		generation = body.generation;
		return { generation, status: "staging" };
	};
	api.uploadSessionEventGenerationChunk = async (input) => {
		if (input.startSeq !== received || input.baseHeadHash !== head)
			throw new Error("upload gap or wrong prefix");
		const lines = input.file.toString("ascii").trimEnd().split("\n");
		for (const line of lines) {
			const parsed: { seq: number; parts: Array<{ text: string }> } = JSON.parse(line);
			if (parsed.seq !== received || !parsed.parts[0]?.text.startsWith(`${received}:`))
				throw new Error("lost or reordered source row");
			const eventHash = createHash("sha256").update(line, "ascii").digest();
			head = createHash("sha256").update(Buffer.from(head, "hex")).update(eventHash).digest("hex");
			received++;
		}
		chunks++;
		return {
			generation,
			start_seq: input.startSeq,
			end_seq: received - 1,
			count: lines.length,
			content_hash: createHash("sha256").update(input.file).digest("hex"),
			result_head_hash: head,
		};
	};
	api.commitSessionEventGeneration = async (_id, selectedGeneration, body) => {
		if (received !== count || body.final_count !== received || body.final_head_hash !== head)
			throw new Error("incomplete or incorrect committed history");
		return { generation: selectedGeneration, revision: 1, count: received, head_hash: head };
	};
	const result = await syncSessionContent({
		api,
		session,
		plan,
		fence: sessionFence(api, {
			environmentId: "memory-agent",
			adapter: adapter.agentType,
			sourceSessionKey: localSessionId,
		}),
		needsSnapshotContent: false,
	});
	if (result.status !== "synced" || received !== count)
		throw new Error("history did not sync completely");
	console.log(
		JSON.stringify({
			adapter: selected,
			result: result.status,
			received,
			chunks,
			head,
			maxRssKiB: process.resourceUsage().maxRSS,
		}),
	);
}
