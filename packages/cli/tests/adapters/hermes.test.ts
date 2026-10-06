import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanSessionModule } from "../../src/adapters/base";
import { HermesAdapter } from "../../src/adapters/hermes";
import { assertSessionGolden } from "../../src/adapters/session-golden.test-support";
import { computeLastActivityIso } from "../../src/lib/session-activity";
import { projectEventsToMessages } from "../../src/lib/session-events";
import { prepareSessionUpload } from "../../src/lib/session-upload";
import { tarSkillDir } from "../../src/lib/tar";
import { reserveManagedSkill } from "../../src/runtime/managed-skill-reservation";
import {
	type AgentHomeOverrideSnapshot,
	restoreAgentHomeOverrides,
	snapshotAndClearAgentHomeOverrides,
} from "../commands/helpers";
import inlineImage from "../fixtures/hermes-inline-image.json";
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
	it("preserves origin/main session bytes and localHash", async () => {
		await assertSessionGolden("hermes", new HermesAdapter().sessions);
	});
	it.each([false, true])("retains rewind and superseded rows as hidden audit events (streaming=%s)", async (streaming) => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		try {
			db.run("DELETE FROM messages");
			const insert = db.prepare("INSERT INTO messages (session_id, role, content, timestamp, active, compacted, display_metadata) VALUES ('s-modern', ?, ?, ?, ?, ?, ?)");
			insert.run("user", "Rewound prompt", 1776247201, 0, 0, null);
			insert.run("assistant", "Rewound answer", 1776247202, 0, 0, null);
			insert.run("user", "Superseded original prompt", 1776247203, 0, 0, null);
			insert.run("assistant", "Superseded original answer", 1776247204, 0, 0, null);
			insert.run("user", "Model-only prompt", 1776247205, 1, 0, '{"model_only":true}');
			insert.run("assistant", "Model-only answer", 1776247206, 1, 0, '{"model_only":1}');
			insert.run("user", "Archived prompt", 1776247207, 0, 1, null);
			insert.run("assistant", "Current answer", 1776247208, 1, 0, null);
		} finally {
			db.close();
		}
		const session = await new HermesAdapter().sessions.resolve("s-modern", {
			streaming,
			signal: new AbortController().signal,
		});
		if (!session) throw new Error("Expected Hermes rewind fixture");
		const events = [];
		for await (const event of session.readEvents?.() ?? session.events ?? []) events.push(event);
		expect(events).toHaveLength(8);
		expect(events.slice(0, 4).map((event) => event.semantics)).toEqual(
			Array(4).fill({ lifecycle: "inactive", display: "hidden", compressed_summary: false }),
		);
		expect(events.slice(4, 6).map((event) => event.semantics)).toEqual(
			Array(2).fill({ lifecycle: "active", display: "hidden", compressed_summary: false }),
		);
		expect(projectEventsToMessages(events).map((message) => message.content)).toEqual([
			"Archived prompt", "Current answer",
		]);
		expect(session.messageCount).toBe(2);
	});
	it.each([false, true])("hides later compaction generations (display_identity=%s)", async (withIdentity) => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		try {
			db.run("DELETE FROM messages");
			if (withIdentity) db.run("ALTER TABLE messages ADD COLUMN display_identity BLOB");
			const insert = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, active, compacted, _compressed_summary, tool_calls, tool_call_id, tool_name) VALUES (?, 's-modern', ?, ?, ?, ?, ?, ?, ?, ?, ?)");
			const calls = (argumentsValue: string) => JSON.stringify([
				{ id: "call-tail", type: "function", function: { name: "read", arguments: argumentsValue } },
			]);
			insert.run(1, "user", "Tail prompt", 1776247201, 0, 0, 0, null, null, null);
			insert.run(2, "user", "Tail prompt", 1776247201, 0, 1, 0, null, null, null);
			insert.run(3, "assistant", "Tail answer", 1776247202, 0, 1, 0, null, null, null);
			insert.run(4, "assistant", null, 1776247203, 0, 1, 0, calls('{"path":"README.md","context":"full"}'), null, null);
			insert.run(5, "tool", "Full output", 1776247204, 0, 1, 0, null, "call-tail", "read");
			insert.run(6, "assistant", "Summary", 1776247210, 1, 0, 1, null, null, null);
			insert.run(7, "user", "Tail prompt", 1776247201, 1, 0, 0, null, null, null);
			insert.run(8, "assistant", "Tail answer", 1776247202, 1, 0, 0, null, null, null);
			insert.run(9, "assistant", null, 1776247203, 1, 0, 0, JSON.stringify([{ id: "response-item", call_id: "call-tail|response-item", function: { name: "read", arguments: '{"path":"README.md"}' } }]), null, null);
			insert.run(10, "tool", "Full output", 1776247204, 1, 0, 0, null, "call-tail", "read");
			insert.run(11, "user", "Tail prompt", 1776247211, 1, 0, 0, null, null, null);
			// Pruned tool results keep their payload in the key, unlike assistant calls.
			insert.run(12, "tool", "Pruned output", 1776247204, 1, 0, 0, null, "call-tail", "read");
			if (withIdentity) {
				db.run("UPDATE messages SET display_identity = X'01' WHERE id IN (1, 2, 7)");
				db.run("UPDATE messages SET display_identity = X'02' WHERE id IN (3, 8)");
				// Durable identities take precedence over the fallback content key.
				db.run("UPDATE messages SET content = 'Tail answer copy' WHERE id = 8");
			}
		} finally {
			db.close();
		}
		let eagerEvents;
		for (const streaming of [false, true]) {
			const session = await new HermesAdapter().sessions.resolve("s-modern", {
				streaming, signal: new AbortController().signal,
			});
			if (!session) throw new Error("Expected Hermes generation fixture");
			const events = [];
			for await (const event of session.readEvents?.() ?? session.events ?? []) events.push(event);
			expect(events).toHaveLength(12);
			expect(events.filter((event) => event.semantics?.display === "hidden").map((event) => event.source.record_id)).toEqual(["1", "7", "8", "9", "10"]);
			expect(projectEventsToMessages(events).map((message) => message.content)).toEqual([
				"Tail prompt", "Tail answer", "Summary", "Tail prompt",
			]);
			expect(events.find((event) => event.source.record_id === "4")).toMatchObject({
				type: "tool_call", arguments_json: '{"context":"full","path":"README.md"}',
				semantics: { lifecycle: "compacted", display: "message" },
			});
			expect(events.find((event) => event.source.record_id === "9")).toMatchObject({
				type: "tool_call", semantics: { lifecycle: "active", display: "hidden" },
			});
			if (streaming) expect(events).toEqual(eagerEvents);
			else eagerEvents = events;
		}
	});
	it("reads modelsUsed in first_seen order without changing projected event bytes", async () => {
		const adapter = new HermesAdapter();
		const before = await adapter.sessions.resolve("s-modern");
		if (!before) throw new Error("Expected Hermes model-usage fixture");
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		try {
			db.exec(`CREATE TABLE session_model_usage (
				session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL,
				first_seen REAL, PRIMARY KEY (session_id, model, billing_provider)
			)`);
			const insert = db.prepare("INSERT INTO session_model_usage VALUES ('s-modern', ?, ?, ?)");
			insert.run("gpt-5.5", "openai", 30);
			insert.run("claude-opus-4-7", "anthropic", 20);
			insert.run("gpt-5.5", "custom", 10);
		} finally {
			db.close();
		}
		for (const streaming of [false, true]) {
			const after = await adapter.sessions.resolve("s-modern", {
				streaming, signal: new AbortController().signal,
			});
			if (!after) throw new Error("Expected Hermes model-usage fixture");
			expect(after.model).toBe(before.model);
			expect(after.modelsUsed).toEqual(["gpt-5.5", "claude-opus-4-7"]);
			const events = [];
			for await (const event of after.readEvents?.() ?? after.events ?? []) events.push(event);
			expect(events).toEqual(before.events);
			expect((await prepareSessionUpload(after, "events-v1")).localHash).toBe((await prepareSessionUpload(before, "events-v1")).localHash);
			expect(after.sourceRevision).not.toBe(before.sourceRevision);
		}
		const cleanup = new Database(join(tmpHome, ".hermes", "state.db"));
		try { cleanup.exec("DROP TABLE session_model_usage"); } finally { cleanup.close(); }
		expect((await adapter.sessions.resolve("s-modern"))?.modelsUsed).toEqual(["gpt-5.3-codex"]);
	});
	it.each(["user", "tool"])(
		"re-maps persisted %s inline images without invalid attachment metadata",
		async (role) => {
			const db = new Database(join(tmpHome, ".hermes", "state.db"));
			db.run("UPDATE messages SET role = ?, content = ? WHERE id = 4", [
				role,
				`\0json:${JSON.stringify(inlineImage.content)}`,
			]);
			db.close();
			const adapter = new HermesAdapter();
			const eager = await adapter.sessions.resolve("s-modern");
			const streamed = await adapter.sessions.resolve("s-modern", {
				signal: new AbortController().signal,
				streaming: true,
			});
			if (!eager || !streamed?.readEvents) throw new Error("expected Hermes event readers");
			const streamEvents = [];
			for await (const event of streamed.readEvents()) streamEvents.push(event);
			expect(streamEvents).toEqual(eager.events);
			const result = streamEvents.find((event) => event.source.record_id === "4");
			expect(result).toMatchObject({
				type: role === "user" ? "message" : "tool_result",
				parts: [
					{ type: "text", text: "Synthetic image input" },
					{ type: "attachment", availability: "metadata_only" },
				],
			});
			if (result?.type !== "tool_result" && result?.type !== "message")
				throw new Error("expected image event");
			expect(result.parts[1]).not.toHaveProperty("name");
			expect(JSON.stringify(result)).not.toContain("base64");
		},
	);
	it.each([false, true])("counts projected visible messages (streaming=%s)", async (streaming) => {
		const session = await new HermesAdapter().sessions.resolve("s-modern", {
			streaming,
			signal: new AbortController().signal,
		});
		if (!session) throw new Error("Expected Hermes session fixture");
		const events = [];
		for await (const event of session.readEvents?.() ?? session.events ?? []) events.push(event);
		expect(session.messageCount).toBe(projectEventsToMessages(events).length);
		expect(session.messageCount).toBe(6);
	});

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
			messageCount: 6,
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
				display: "hidden",
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
		// Raw audit rows are retained, with later compaction copies hidden.
		expect(events[6]).toMatchObject({ source: { record_id: "5" } });
		expect(events[15]).toMatchObject({
			source: { record_id: "12" },
			semantics: { lifecycle: "compacted", display: "hidden" },
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

	it.each([
		["plain-model", "plain-model"],
		['{"default":"json-model","api_key":"sk-json-secret"}', "json-model"],
		["{'default': 'repr-model', 'headers': {'Authorization': 'Bearer sk-repr-secret'}}", null],
		['{"default":"broken-model","api_key":"sk-broken-secret"', null],
	])("accepts only strict JSON model objects (%s)", async (stored, expected) => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		try {
			db.run(
				"INSERT INTO sessions (id, source, model, started_at) VALUES ('model-fixture', 'cli', ?, 1776247200)",
				stored,
			);
			db.run(
				"INSERT INTO messages (session_id, role, content, timestamp) VALUES ('model-fixture', 'assistant', 'Safe answer', 1776247201)",
			);
		} finally {
			db.close();
		}
		const session = await new HermesAdapter().sessions.resolve("model-fixture");
		expect(session?.model).toBe(expected);
		expect(JSON.stringify(session)).not.toContain("sk-");
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

	it("reprojects unchanged source rows after the shared projection revision changes", async () => {
		// Captured with projection revision 4; only the mapper version changed.
		const previous = "6ce040ade9bbc99c25a517446b1789db7036860f01f801da3299b58927e82453";
		const scan = await scanSessionModule(
			new HermesAdapter().sessions,
			{ kind: "complete" },
			new Map([["s-modern", previous]]),
		);
		const sessions = [];
		for await (const batch of scan.batches) sessions.push(...batch.sessions);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.sourceRevision).not.toBe(previous);
	});

	it("scans large stores in bounded batches and expands only revised sessions", async () => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		for (let index = 0; index < 40; index++) {
			const id = `bulk-${String(index).padStart(2, "0")}`;
			db.run(
				"INSERT INTO sessions (id, source, title, started_at, message_count) VALUES (?, 'cron', ?, ?, 1)",
				id,
				`Bulk ${index}`,
				1776247000,
			);
			db.run(
				"INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES (?, 'user', ?, ?, 1, 0)",
				id,
				`Message ${index}`,
				1776247000,
			);
		}
		db.run(
			"INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES ('bulk-04', 'assistant', 'Reply', 1776247001, 1, 0)",
		);
		db.close();

		const adapter = new HermesAdapter();
		const initial = await scanSessionModule(adapter.sessions, { kind: "complete" });
		const revisions = new Map<string, string>();
		const initialBatchSizes: number[] = [];
		for await (const batch of initial.batches) {
			initialBatchSizes.push(batch.observedLocalSessionIds.length);
			for (const session of batch.sessions) {
				if (!session.sourceRevision) throw new Error("expected Hermes source revision");
				revisions.set(session.localSessionId, session.sourceRevision);
			}
		}
		expect(initialBatchSizes).toEqual([32, 9]);
		expect(revisions.size).toBe(41);

		const unchanged = await scanSessionModule(adapter.sessions, { kind: "complete" }, revisions);
		let observed = 0;
		let expanded = 0;
		for await (const batch of unchanged.batches) {
			observed += batch.observedLocalSessionIds.length;
			expanded += batch.sessions.length;
		}
		expect({ observed, expanded }).toEqual({ observed: 41, expanded: 0 });

		const changedDb = new Database(join(tmpHome, ".hermes", "state.db"));
		changedDb.run(
			"INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES ('bulk-00', 'assistant', 'Changed', 1776247001, 1, 0)",
		);
		changedDb.run("UPDATE sessions SET title = 'Renamed' WHERE id = 'bulk-01'");
		changedDb.run(
			`UPDATE messages SET display_kind = 'auto_continue', display_metadata = '{"attempt":2}'
			 WHERE session_id = 'bulk-02'`,
		);
		changedDb.run("UPDATE messages SET content = 'M' WHERE session_id = 'bulk-03'");
		changedDb.run("UPDATE messages SET content = 'message 5' WHERE session_id = 'bulk-05'");
		changedDb.run(
			`UPDATE messages
			 SET content = CASE role WHEN 'user' THEN 'Short' ELSE 'Message 4' END
			 WHERE session_id = 'bulk-04'`,
		);
		changedDb.close();
		const changed = await scanSessionModule(adapter.sessions, { kind: "complete" }, revisions);
		const changedIds: string[] = [];
		for await (const batch of changed.batches) {
			changedIds.push(...batch.sessions.map((session) => session.localSessionId));
		}
		expect(changedIds.sort()).toEqual([
			"bulk-00",
			"bulk-01",
			"bulk-02",
			"bulk-03",
			"bulk-04",
			"bulk-05",
		]);
	});

	it("streams a large history without losing sequence, summary, activity or revision fencing", async () => {
		const path = join(tmpHome, ".hermes", "state.db");
		const db = new Database(path);
		db.run(
			"INSERT INTO sessions (id, source, started_at, message_count) VALUES ('large', 'discord', 1776247000, 600)",
		);
		const insert = db.prepare(
			"INSERT INTO messages (session_id, role, content, timestamp) VALUES ('large', 'user', ?, ?)",
		);
		db.transaction(() => {
			for (let index = 0; index < 600; index++)
				insert.run(`Message ${index} ${"x".repeat(8192)}`, 1776247000 + index);
		})();
		db.close();
		const adapter = new HermesAdapter();
		const session = await adapter.sessions.resolve("large");
		if (!session?.readEvents) throw new Error("expected bounded reader");
		expect(session.events).toBeUndefined();
		expect(session.messages).toEqual([]);
		expect(session.summary).toStartWith("Message 0 ");
		expect(session.messageCount).toBe(600);
		expect(computeLastActivityIso(session)).toBe(new Date(1776247599 * 1000).toISOString());
		let count = 0;
		for await (const event of session.readEvents()) {
			expect(event.seq).toBe(count++);
		}
		expect(count).toBe(600);
		const plan = await prepareSessionUpload(session, "events-v1");
		expect(plan.eventCount).toBe(600);
		expect(plan.events).toBeUndefined();
		expect((await prepareSessionUpload(session, "events-v1")).localHash).toBe(plan.localHash);
		const append = new Database(path);
		append.run(
			"INSERT INTO messages (session_id, role, content, timestamp) VALUES ('large', 'user', 'Appended during sync', 1776247600)",
		);
		append.run("UPDATE sessions SET message_count = 601 WHERE id = 'large'");
		append.close();
		expect((await prepareSessionUpload(session, "events-v1")).localHash).toBe(plan.localHash);
		const latest = await adapter.sessions.resolve("large");
		if (!latest) throw new Error("expected appended session");
		expect((await prepareSessionUpload(latest, "events-v1")).eventCount).toBe(601);
		const changed = new Database(path);
		changed.run(
			"UPDATE messages SET active = 0 WHERE session_id = 'large' AND id = (SELECT min(id) FROM messages WHERE session_id = 'large')",
		);
		changed.close();
		await expect(prepareSessionUpload(session, "events-v1")).rejects.toThrow("changed during sync");
		expect(await adapter.sessions.resolve("large")).not.toBeNull();
	});

	it("rejects an oversized source row without materializing its payload", async () => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		db.run(
			"INSERT INTO sessions (id, source, started_at) VALUES ('oversized', 'discord', 1776247000)",
		);
		db.run(
			"INSERT INTO messages (session_id, role, content, timestamp) VALUES ('oversized', 'user', zeroblob(9000000), 1776247000)",
		);
		db.close();
		await expect(new HermesAdapter().sessions.resolve("oversized")).rejects.toThrow("source bytes");
	});

	it("classifies user rows from Hermes conversations, including compression splits", async () => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		for (const [id, source, parentSessionId, modelConfig, timestamp] of [
			["activity-root", "telegram", null, null, 2_000_000_000],
			["activity-cron", "cron", null, null, 2_000_000_600],
			["activity-subagent", "subagent", null, null, 2_000_000_700],
			["activity-curator", "curator", null, null, 2_000_000_800],
			["activity-kanban", "kanban", null, null, 2_000_000_900],
			[
				"activity-delegate",
				"telegram",
				"activity-root",
				'{"_delegate_from":"activity-root"}',
				2_000_001_000,
			],
			// A compression split continues the same conversation under a new session row.
			["activity-split", "telegram", "activity-root", null, 2_000_000_400],
		] as const) {
			db.run(
				"INSERT INTO sessions (id, source, parent_session_id, model_config, title, started_at, message_count) VALUES (?, ?, ?, ?, ?, ?, 1)",
				id,
				source,
				parentSessionId,
				modelConfig,
				id,
				timestamp,
			);
			db.run(
				"INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES (?, 'user', 'input', ?, 1, 0)",
				id,
				timestamp,
			);
		}
		db.close();

		const scan = await scanSessionModule(new HermesAdapter().sessions, { kind: "complete" });

		expect(scan.userActivity).toEqual({
			lastUserInputAt: new Date(2_000_000_400 * 1000).toISOString(),
			complete: true,
		});
	});

	it("fails Hermes activity closed when the session source is unavailable", async () => {
		const db = new Database(join(tmpHome, ".hermes", "state.db"));
		db.exec(`
			ALTER TABLE sessions DROP COLUMN source;
		`);
		db.close();

		const scan = await scanSessionModule(new HermesAdapter().sessions, { kind: "complete" });
		expect(scan.userActivity).toEqual({ lastUserInputAt: null, complete: false });
		// Session batches need the same column; draining them surfaces the schema error.
		await expect(
			(async () => {
				for await (const _batch of scan.batches) {
					// Drain so the read-only SQLite handle closes.
				}
			})(),
		).rejects.toThrow("no such column: source");
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
		for (const key of [
			"bad key",
			"apple/_private",
			"中文",
			"a/b/c/d/e",
			"a".repeat(201),
			"team/download",
			"demo\n",
		]) {
			mkdirSync(join(skillsRoot, key), { recursive: true });
			writeFileSync(join(skillsRoot, key, "SKILL.md"), "# Invalid key fixture\n");
		}
		for (const key of ["Team.tools/Demo_v1", "valid/nested/at/limit"]) {
			mkdirSync(join(skillsRoot, key), { recursive: true });
			writeFileSync(join(skillsRoot, key, "SKILL.md"), "# Valid key fixture\n");
		}

		const a = new HermesAdapter();
		const skills = await a.skills.collect();
		const keys = skills.map((s) => s.skillKey).sort();

		expect(keys).toEqual(["Team.tools/Demo_v1", "core/demo", "valid/nested/at/limit"]);
		expect((await a.skills.listKeys()).sort()).toEqual(keys);
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

	it("refuses to write shared content over the reserved shared target", async () => {
		const skillsRoot = join(tmpHome, ".hermes", "skills");
		const sharedRoot = join(skillsRoot, "shared", "demo__owner");
		mkdirSync(sharedRoot, { recursive: true });
		writeFileSync(join(sharedRoot, "SKILL.md"), "# Managed shared namespace\n");
		reserveManagedSkill({
			targetDir: sharedRoot,
			id: "demo__owner",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		const tarBytes = await tarSkillDir(join(skillsRoot, "core", "demo"));

		const adapter = new HermesAdapter();
		await expect(adapter.skills.writeSharedArchive("demo", "owner", tarBytes)).rejects.toThrow(
			"Skill demo__owner is reserved by a managed Skill owner",
		);
		expect(readFileSync(join(sharedRoot, "SKILL.md"), "utf8")).toBe("# Managed shared namespace\n");
	});

	it("getSkillPath returns the canonical SKILL.md anchor under skills/", () => {
		const a = new HermesAdapter();
		const p = a.skills.path("foo");
		expect(p).toBe(join(tmpHome, ".hermes", "skills", "foo", "SKILL.md"));
	});
});
