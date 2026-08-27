import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HermesAdapter } from "../../src/adapters/hermes";
import { tarSkillDir } from "../../src/lib/tar";
import { reserveManagedSkill } from "../../src/runtime/managed-skill-reservation";
import {
	type AgentHomeOverrideSnapshot,
	restoreAgentHomeOverrides,
	snapshotAndClearAgentHomeOverrides,
} from "../commands/helpers";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origHomeOverrides: AgentHomeOverrideSnapshot = {};

beforeEach(() => {
	origHome = process.env.HOME;
	origHomeOverrides = snapshotAndClearAgentHomeOverrides();
	tmpHome = copyFixtureToTmp("hermes");
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	restoreAgentHomeOverrides(origHomeOverrides);
	origHomeOverrides = {};
	cleanupTmp(tmpHome);
});

describe("HermesAdapter.detect", () => {
	it("returns true when $HOME/.hermes exists", async () => {
		const a = new HermesAdapter();
		expect(await a.detect()).toBe(true);
	});

	it("returns false when $HOME/.hermes is absent", async () => {
		process.env.HOME = `/tmp/clawdi-nowhere-${Date.now()}`;
		const a = new HermesAdapter();
		expect(await a.detect()).toBe(false);
	});
});

describe("HermesAdapter.collectSessions", () => {
	it("selects events-v1 and maps every safe modern row in stable source order", async () => {
		const a = new HermesAdapter();
		expect(await a.sessions.contentProtocol()).toBe("events-v1");
		const { sessions } = await a.sessions.collect({ kind: "complete" });
		expect(sessions).toHaveLength(1);
		const session = sessions[0];
		expect(session).toMatchObject({
			localSessionId: "s-modern",
			projectPath: null,
			model: "gpt-5.3-codex",
			modelsUsed: ["gpt-5.3-codex"],
			messageCount: 12,
			inputTokens: 120,
			outputTokens: 45,
			cacheReadTokens: 8,
			summary: "Inspect this report",
		});
		expect(session?.rawFilePath).toContain("state.db#s-modern");
		expect((await a.sessions.resolve("s-modern"))?.events).toEqual(session?.events);
		expect(await a.sessions.resolve("missing-session")).toBeNull();

		const events = session?.events ?? [];
		expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
		expect(events.map((event) => event.source.record_id)).toEqual([
			"1",
			"2",
			"3",
			"3",
			"3",
			"4",
			"5",
			"6",
			"7",
			"8",
			"8",
			"9",
			"10",
			"10",
			"11",
			"12",
		]);
		expect(events[0]).toMatchObject({ type: "message", role: "system" });
		expect(events[1]).toMatchObject({
			type: "message",
			role: "user",
			parts: [
				{ type: "text", text: "Inspect this report" },
				{
					type: "attachment",
					availability: "external",
					uri: "https://cdn.example.com/report.png",
					media_type: "image/png",
				},
			],
			semantics: {
				lifecycle: "active",
				display: "message",
				display_metadata: {
					reactions: [{ emoji: "thumbs-up", author: "user" }],
				},
			},
		});
		expect(events[2]).toMatchObject({
			type: "reasoning",
			parts: [{ type: "text", text: "hidden row reasoning" }],
			payload_json: '{"items":[{"text":"hidden codex reasoning","type":"reasoning"}]}',
			semantics: { lifecycle: "compacted" },
		});
		expect(events[3]).toMatchObject({
			type: "tool_call",
			call_id: "call-search",
			name: "search",
			arguments_json: '{"api_key":"sk-tool-secret","query":"Hermes"}',
			semantics: { lifecycle: "compacted" },
		});
		expect(events[4]).toMatchObject({
			type: "tool_call",
			call_id: "call-read",
			name: "read_file",
		});
		expect(events[5]).toMatchObject({
			type: "tool_result",
			call_id: "call-search",
			name: "search",
			parts: [{ type: "text", text: "Found one result" }],
			result_json: '[{"items":[{"id":1}],"ok":true,"password":"result-secret"}]',
			semantics: { lifecycle: "compacted" },
		});
		expect(events[8]).toMatchObject({
			type: "message",
			role: "user",
			semantics: {
				lifecycle: "inactive",
				display: "event",
				display_kind: "auto_continue",
				display_metadata: { attempt: 2 },
			},
		});
		expect(events[7]).toMatchObject({
			type: "message",
			parts: [{ type: "text", text: "Summary of earlier turns" }],
			semantics: { compressed_summary: true },
		});
		expect(events[9]).toMatchObject({
			type: "reasoning",
			parts: [
				{ type: "text", text: "hidden reasoning" },
				{ type: "text", text: "hidden reasoning content" },
				{ type: "text", text: "hidden inline reasoning" },
			],
			payload_json: '{"details":{"encrypted_content":"opaque reasoning"}}',
		});
		expect(events[10]).toMatchObject({
			type: "message",
			parts: [{ type: "text", text: "Public answer" }],
		});
		expect(events[11]).toMatchObject({
			semantics: {
				display: "event",
				display_kind: "async_delegation_complete",
				display_metadata: { task_count: 2 },
			},
		});
		// Assistant rows with visible content + tool_calls produce one message and one call.
		expect(events.slice(12, 14).map((event) => event.type)).toEqual(["message", "tool_call"]);
		// Raw audit rows are retained: the compaction copy remains distinct and marked compacted.
		expect(events[6]).toMatchObject({ source: { record_id: "5" } });
		expect(events[15]).toMatchObject({
			source: { record_id: "12" },
			semantics: { lifecycle: "compacted" },
		});
		expect(events[14]).toMatchObject({
			type: "tool_result",
			result_json: '{"authorization":"Bearer secret","lines":42,"ok":true}',
		});

		const serialized = JSON.stringify(session);
		for (const reasoning of [
			"hidden row reasoning",
			"hidden codex reasoning",
			"hidden inline reasoning",
			"hidden reasoning content",
			"opaque reasoning",
		]) {
			expect(serialized).toContain(reasoning);
		}
		for (const hidden of [
			"sk-model-secret",
			"sk-config-secret",
			"provider envelope secret",
			"display-secret",
			"metadata-secret",
		]) {
			expect(serialized).not.toContain(hidden);
		}
	});

	it("keeps prior identities as an append-only prefix when a row is added", async () => {
		const adapter = new HermesAdapter();
		const before = (await adapter.sessions.resolve("s-modern"))?.events ?? [];
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		db.run(
			"INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES (?, ?, ?, ?, 1, 0)",
			"s-modern",
			"user",
			"Appended turn",
			1776247261,
		);
		db.close();

		const after = (await adapter.sessions.resolve("s-modern"))?.events ?? [];
		expect(after.slice(0, before.length).map((event) => event.event_id)).toEqual(
			before.map((event) => event.event_id),
		);
		expect(after.at(-1)).toMatchObject({
			seq: before.length,
			type: "message",
			source: { adapter: "hermes", record_id: "13", record_seq: 13 },
		});
	});

	it("uses events-v1 with stable ids when newer optional message columns are absent", async () => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		db.exec(`
			DROP TABLE messages;
			CREATE TABLE messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT,
				timestamp REAL NOT NULL
			);
			INSERT INTO messages (session_id, role, content, timestamp) VALUES
				('s-modern', 'developer', '<think>literal developer content', 1776247201),
				('s-modern', 'assistant', 'Visible answer', 1776247202);
		`);
		db.close();

		const adapter = new HermesAdapter();
		expect(await adapter.sessions.contentProtocol()).toBe("events-v1");
		const session = await adapter.sessions.resolve("s-modern");
		expect(session?.events).toMatchObject([
			{
				type: "message",
				role: "developer",
				parts: [{ type: "text", text: "<think>literal developer content" }],
				source: { record_id: "1", record_seq: 1 },
				semantics: {
					lifecycle: "active",
					display: "message",
					compressed_summary: false,
				},
			},
			{
				type: "message",
				role: "assistant",
				source: { record_id: "2", record_seq: 2 },
			},
		]);
	});

	it("scrubs upstream reasoning tags only from assistant model output", async () => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		const insert = db.prepare(
			"INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp, active, compacted) VALUES (?, ?, ?, ?, ?, ?, 1, 0)",
		);
		insert.run("s-modern", "user", "<thinking>literal user content", null, null, 1776247261);
		insert.run("s-modern", "system", "<thought>literal system content", null, null, 1776247262);
		insert.run(
			"s-modern",
			"tool",
			"<REASONING_SCRATCHPAD>literal tool content",
			"call-literal",
			"literal_tool",
			1776247263,
		);
		insert.run(
			"s-modern",
			"assistant",
			"<think>hidden think</think><thinking>hidden thinking</thinking><reasoning>hidden reasoning</reasoning><thought>hidden thought</thought><REASONING_SCRATCHPAD>hidden scratchpad</REASONING_SCRATCHPAD>Visible assistant",
			null,
			null,
			1776247264,
		);
		insert.run(
			"s-modern",
			"assistant",
			'Use the <think> element in prose.\nconst tag = "<reasoning>";\n  <thought>hidden tail',
			null,
			null,
			1776247265,
		);
		db.close();

		const session = await new HermesAdapter().sessions.resolve("s-modern");
		const events = session?.events ?? [];
		const added = events.filter((event) => event.source.record_seq > 12);
		expect(added).toMatchObject([
			{
				type: "message",
				role: "user",
				parts: [{ type: "text", text: "<thinking>literal user content" }],
			},
			{
				type: "message",
				role: "system",
				parts: [{ type: "text", text: "<thought>literal system content" }],
			},
			{
				type: "tool_result",
				parts: [{ type: "text", text: "<REASONING_SCRATCHPAD>literal tool content" }],
			},
			{
				type: "reasoning",
				kind: "reasoning",
				parts: [
					{ type: "text", text: "hidden think" },
					{ type: "text", text: "hidden thinking" },
					{ type: "text", text: "hidden reasoning" },
					{ type: "text", text: "hidden thought" },
					{ type: "text", text: "hidden scratchpad" },
				],
			},
			{
				type: "message",
				role: "assistant",
				parts: [{ type: "text", text: "Visible assistant" }],
			},
			{
				type: "reasoning",
				kind: "reasoning",
				parts: [{ type: "text", text: "hidden tail" }],
			},
			{
				type: "message",
				role: "assistant",
				parts: [
					{
						type: "text",
						text: 'Use the <think> element in prose.\nconst tag = "<reasoning>";\n  ',
					},
				],
			},
		]);
		for (const hidden of [
			"hidden think",
			"hidden thinking",
			"hidden reasoning",
			"hidden thought",
			"hidden scratchpad",
			"hidden tail",
		]) {
			expect(JSON.stringify(added)).toContain(hidden);
			expect(JSON.stringify(session?.messages)).not.toContain(hidden);
		}
	});

	it("falls back to snapshot-v1 for a legacy messages table without stable ids", async () => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		db.exec(`
			DROP TABLE messages;
			CREATE TABLE messages (
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT,
				timestamp REAL NOT NULL
			);
			INSERT INTO messages VALUES
				('s-modern', 'user', 'legacy question', 1776247201),
				('s-modern', 'assistant', 'legacy answer', 1776247202);
		`);
		db.close();

		const adapter = new HermesAdapter();
		expect(await adapter.sessions.contentProtocol()).toBe("snapshot-v1");
		const session = await adapter.sessions.resolve("s-modern");
		expect(session?.events).toBeUndefined();
		expect(session?.messages).toEqual([
			{
				role: "user",
				content: "legacy question",
				timestamp: "2026-04-15T10:00:01.000Z",
			},
			{
				role: "assistant",
				content: "legacy answer",
				model: "gpt-5.3-codex",
				timestamp: "2026-04-15T10:00:02.000Z",
			},
		]);
	});
});

describe("HermesAdapter.collectSkills", () => {
	it("finds a nested skill at skills/core/demo/SKILL.md and skips SKIP_DIRS at every depth", async () => {
		const a = new HermesAdapter();
		const skills = await a.skills.collect();
		// `core/demo` is the real nested skill. The fixture also plants
		// `skills/node_modules/bad/SKILL.md` — Hermes' scanner recurses, so
		// SKIP_DIRS must apply at the root level AND block the recursion.
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			skillKey: "core/demo",
			name: "demo",
		});
		expect(skills[0]?.content).toContain("description: A nested demo skill");
	});

	it("skips archived dot-directories and invalid skill keys at every depth", async () => {
		const skillsRoot = join(tmpHome, ".hermes", "skills");
		mkdirSync(join(skillsRoot, ".archive", "old-skill"), { recursive: true });
		writeFileSync(join(skillsRoot, ".archive", "old-skill", "SKILL.md"), "---\nname: old\n---\n");
		mkdirSync(join(skillsRoot, "apple", ".archive", "old-reminders"), { recursive: true });
		writeFileSync(
			join(skillsRoot, "apple", ".archive", "old-reminders", "SKILL.md"),
			"---\nname: old reminders\n---\n",
		);
		mkdirSync(join(skillsRoot, "bad key"), { recursive: true });
		writeFileSync(join(skillsRoot, "bad key", "SKILL.md"), "---\nname: bad key\n---\n");
		mkdirSync(join(skillsRoot, "apple", "_private"), { recursive: true });
		writeFileSync(join(skillsRoot, "apple", "_private", "SKILL.md"), "---\nname: private\n---\n");

		const a = new HermesAdapter();
		const skills = await a.skills.collect();
		const keys = skills.map((s) => s.skillKey).sort();

		expect(keys).toEqual(["core/demo"]);
		expect(await a.skills.listKeys()).toEqual(["core/demo"]);
	});

	it("returns empty when skills dir is missing", async () => {
		// Point HOME at a fresh tmpdir with no .hermes/
		process.env.HOME = `/tmp/clawdi-empty-${Date.now()}`;
		const a = new HermesAdapter();
		expect(await a.skills.collect()).toEqual([]);
	});
});

describe("HermesAdapter.writeSkillArchive + getSkillPath", () => {
	it("extracts a tar.gz round-trip (key matches archive root dir)", async () => {
		// In production, skill.ts derives skillKey from basename(path) and then
		// tars that dir — so key always matches the archive's internal top-level
		// dirname. Test preserves that invariant.
		const srcDir = join(tmpHome, ".hermes", "skills", "core", "demo");
		const tarBytes = await tarSkillDir(srcDir);

		// Remove source first so we can tell it was re-extracted.
		const a = new HermesAdapter();
		await a.skills.writeArchive("demo", tarBytes);

		const extracted = join(tmpHome, ".hermes", "skills", "demo", "SKILL.md");
		expect(existsSync(extracted)).toBe(true);
		expect(readFileSync(extracted, "utf-8")).toContain("description: A nested demo skill");
	});

	it("refuses to write shared content through a managed shared namespace", async () => {
		const skillsRoot = join(tmpHome, ".hermes", "skills");
		const sharedRoot = join(skillsRoot, "shared");
		mkdirSync(sharedRoot, { recursive: true });
		writeFileSync(join(sharedRoot, "SKILL.md"), "# Managed shared namespace\n");
		reserveManagedSkill({
			targetDir: sharedRoot,
			id: "shared",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		const tarBytes = await tarSkillDir(join(skillsRoot, "core", "demo"));

		const adapter = new HermesAdapter();
		await expect(adapter.skills.writeSharedArchive("demo", "owner", tarBytes)).rejects.toThrow(
			"Skill shared is reserved by a managed Skill owner",
		);
		expect(readFileSync(join(sharedRoot, "SKILL.md"), "utf8")).toBe("# Managed shared namespace\n");
		expect(existsSync(join(sharedRoot, "demo__owner"))).toBe(false);
	});

	it("getSkillPath returns the canonical SKILL.md anchor under skills/", () => {
		const a = new HermesAdapter();
		const p = a.skills.path("foo");
		expect(p).toBe(join(tmpHome, ".hermes", "skills", "foo", "SKILL.md"));
	});
});
