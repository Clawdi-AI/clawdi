import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import syntheticTextFixture from "../../tests/fixtures/opencode-synthetic-text.json";
import { projectEventsToMessages } from "../lib/session-events";
import { prepareSessionUpload } from "../lib/session-upload";
import { OpenCodeAdapter } from "./opencode";
import { assertSessionGolden } from "./session-golden.test-support";

const originalDb = process.env.OPENCODE_DB;
const originalXdgData = process.env.XDG_DATA_HOME;
const temporaryRoots: string[] = [];

afterEach(() => {
	if (originalDb === undefined) delete process.env.OPENCODE_DB;
	else process.env.OPENCODE_DB = originalDb;
	if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = originalXdgData;
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function insertJson(db: Database, table: "message" | "part", values: (string | number)[]): void {
	if (table === "message") {
		db.run(
			"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
			values,
		);
		return;
	}
	db.run(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
		values,
	);
}

function fixtureDatabase(): { adapter: OpenCodeAdapter; databasePath: string } {
	const root = mkdtempSync(join(tmpdir(), "clawdi-opencode-adapter-"));
	temporaryRoots.push(root);
	const databasePath = join(root, "data", "opencode.db");
	mkdirSync(dirname(databasePath), { recursive: true });
	process.env.OPENCODE_DB = databasePath;
	delete process.env.XDG_DATA_HOME;
	const db = new Database(databasePath);
	db.exec(`
		CREATE TABLE session (
			id TEXT PRIMARY KEY,
			directory TEXT NOT NULL,
			title TEXT NOT NULL,
			version TEXT NOT NULL,
			tokens_input INTEGER NOT NULL DEFAULT 0,
			tokens_output INTEGER NOT NULL DEFAULT 0,
			tokens_reasoning INTEGER NOT NULL DEFAULT 0,
			tokens_cache_read INTEGER NOT NULL DEFAULT 0,
			tokens_cache_write INTEGER NOT NULL DEFAULT 0,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			time_archived INTEGER,
			model TEXT,
			agent TEXT
		);
		CREATE TABLE message (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL
		);
		CREATE TABLE part (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL
		);
	`);
	const started = Date.parse("2026-08-27T10:00:00.000Z");
	db.run(
		`INSERT INTO session (
			id, directory, title, version, tokens_input, tokens_output,
			tokens_reasoning, tokens_cache_read, tokens_cache_write,
			time_created, time_updated, model, agent
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			"ses_fixture",
			"/workspace/opencode",
			"New session - 2026-08-27T10:00:00.000Z",
			"1.18.23",
			120,
			42,
			18,
			9,
			3,
			started,
			started + 5000,
			JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic" }),
			"build",
		],
	);
	insertJson(db, "message", [
		"msg_user",
		"ses_fixture",
		started + 1000,
		started + 1000,
		JSON.stringify({
			role: "user",
			time: { created: started + 1000 },
			agent: "build",
			model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
			system: "Private OpenCode system instruction",
			providerEnvelope: "must-not-upload",
		}),
	]);
	insertJson(db, "part", [
		"prt_001",
		"msg_user",
		"ses_fixture",
		started + 1000,
		started + 1000,
		JSON.stringify({ type: "text", text: "Inspect this workspace" }),
	]);
	insertJson(db, "part", [
		"prt_002",
		"msg_user",
		"ses_fixture",
		started + 1001,
		started + 1001,
		JSON.stringify({
			type: "file",
			mime: "text/plain",
			filename: "report.txt",
			url: "file:///private/workspace/report.txt",
			source: { type: "file", path: "/private/workspace/report.txt" },
		}),
	]);
	insertJson(db, "message", [
		"msg_assistant",
		"ses_fixture",
		started + 2000,
		started + 5000,
		JSON.stringify({
			role: "assistant",
			time: { created: started + 2000, completed: started + 5000 },
			parentID: "msg_user",
			providerID: "anthropic",
			modelID: "claude-sonnet-4-5",
			mode: "build",
			agent: "build",
			path: { cwd: "/private/workspace", root: "/private" },
			providerEnvelope: "must-not-upload",
		}),
	]);
	insertJson(db, "part", [
		"prt_003",
		"msg_assistant",
		"ses_fixture",
		started + 2000,
		started + 2100,
		JSON.stringify({
			type: "reasoning",
			text: "Private OpenCode reasoning",
			metadata: { anthropic: { signature: "opaque-signature" } },
			time: { start: started + 2000, end: started + 2100 },
		}),
	]);
	insertJson(db, "part", [
		"prt_004",
		"msg_assistant",
		"ses_fixture",
		started + 2200,
		started + 2200,
		JSON.stringify({ type: "text", text: "Visible OpenCode answer" }),
	]);
	insertJson(db, "part", [
		"prt_005",
		"msg_assistant",
		"ses_fixture",
		started + 2300,
		started + 3000,
		JSON.stringify({
			type: "tool",
			callID: "call_read",
			tool: "read",
			state: {
				status: "completed",
				input: { filePath: "/workspace/opencode/README.md", apiKey: "tool-input-preserved" },
				output: "Tool output",
				title: "Read README",
				metadata: { lines: 12 },
				time: { start: started + 2300, end: started + 3000 },
				attachments: [
					{
						type: "file",
						mime: "image/png",
						filename: "preview.png",
						url: "file:///private/output/preview.png",
					},
				],
			},
		}),
	]);
	insertJson(db, "part", [
		"prt_006",
		"msg_assistant",
		"ses_fixture",
		started + 3100,
		started + 3200,
		JSON.stringify({
			type: "tool",
			callID: "call_shell",
			tool: "shell",
			state: {
				status: "error",
				input: { command: "false" },
				error: "Command failed",
				metadata: { exitCode: 1 },
				time: { start: started + 3100, end: started + 3200 },
			},
		}),
	]);
	insertJson(db, "part", [
		"prt_007",
		"msg_assistant",
		"ses_fixture",
		started + 3300,
		started + 3300,
		JSON.stringify({ type: "text", text: "Internal ignored separator", ignored: true }),
	]);
	insertJson(db, "part", [
		"prt_008",
		"msg_assistant",
		"ses_fixture",
		started + 4000,
		started + 4000,
		JSON.stringify({
			type: "step-finish",
			reason: "stop",
			cost: 0.02,
			tokens: { input: 120, output: 42, reasoning: 18, cache: { read: 9, write: 3 } },
		}),
	]);
	insertJson(db, "part", [
		"prt_009",
		"msg_assistant",
		"ses_fixture",
		started + 4100,
		started + 4100,
		JSON.stringify({
			type: "patch",
			hash: "private-snapshot-hash",
			files: ["/private/workspace/secret.ts"],
		}),
	]);
	db.close();
	return { adapter: new OpenCodeAdapter(), databasePath };
}

describe("OpenCode session adapter", () => {
	test("hides synthetic reminders while retaining real user input", async () => {
		const { adapter, databasePath } = fixtureDatabase();
		const db = new Database(databasePath);
		const created = Date.parse("2026-08-27T10:00:00.500Z");
		try {
			insertJson(db, "message", [
				"msg_synthetic",
				"ses_fixture",
				created,
				created,
				JSON.stringify({ role: "user" }),
			]);
			insertJson(db, "part", [
				"prt_synthetic",
				"msg_synthetic",
				"ses_fixture",
				created,
				created,
				JSON.stringify(syntheticTextFixture),
			]);
		} finally {
			db.close();
		}
		for (const streaming of [false, true]) {
			const session = await adapter.sessions.resolve("opencode.ses_fixture", {
				streaming,
				signal: new AbortController().signal,
			});
			if (!session) throw new Error("expected OpenCode synthetic fixture");
			expect(session.messageCount).toBe(2);
			expect(session.summary).toBe("Inspect this workspace");
			const upload = await prepareSessionUpload(session, "events-v1");
			const events = [];
			for await (const event of upload.readEvents?.() ?? upload.events ?? []) events.push(event);
			expect(events.find((event) => event.source.record_id === "prt_synthetic")).toMatchObject({
				semantics: { display: "hidden", display_kind: "synthetic_text", compressed_summary: false },
			});
			expect(projectEventsToMessages(events).map((message) => message.content)).toEqual([
				"Inspect this workspace",
				"Visible OpenCode answer",
			]);
		}
	});
	test.each([
		["/repo/subdirectory", 1],
		["/repo2", 0],
	])("filters cwd %s by project and its descendants", async (cwd, count) => {
		const { adapter, databasePath } = fixtureDatabase();
		const writer = new Database(databasePath);
		try {
			writer.run("UPDATE session SET directory = ?", [cwd]);
		} finally {
			writer.close();
		}
		const scan = await adapter.sessions.collect({ kind: "complete", projectFilter: "/repo" });
		expect(scan.sessions).toHaveLength(count);
	});

	test("preserves origin/main session bytes and localHash", async () => {
		await assertSessionGolden("opencode", fixtureDatabase().adapter.sessions);
	});
	test.each([false, true])(
		"counts projected messages rather than database rows (streaming=%s)",
		async (streaming) => {
			const { adapter, databasePath } = fixtureDatabase();
			const db = new Database(databasePath);
			try {
				insertJson(db, "part", [
					"prt_extra",
					"msg_user",
					"ses_fixture",
					Date.parse("2026-08-27T10:00:01.500Z"),
					Date.parse("2026-08-27T10:00:01.500Z"),
					JSON.stringify({ type: "text", text: "Second user text part" }),
				]);
			} finally {
				db.close();
			}
			const session = await adapter.sessions.resolve("opencode.ses_fixture", {
				streaming,
				signal: new AbortController().signal,
			});
			if (!session) throw new Error("Expected OpenCode session fixture");
			const events = [];
			for await (const event of session.readEvents?.() ?? session.events ?? []) events.push(event);
			expect(session.messageCount).toBe(projectEventsToMessages(events).length);
			expect(session.messageCount).toBe(3);
		},
	);

	test("ignores unread columns in schema validation and source revisions", async () => {
		const { adapter, databasePath } = fixtureDatabase();
		const original = await adapter.sessions.resolve("opencode.ses_fixture");
		const db = new Database(databasePath);
		try {
			db.run(
				"UPDATE session SET version='unused', tokens_reasoning=999, tokens_cache_write=999, time_archived=1, agent='unused'",
			);
			db.run("UPDATE part SET time_updated=1");
		} finally {
			db.close();
		}
		const updated = await adapter.sessions.resolve("opencode.ses_fixture");
		expect(updated?.sourceRevision).toBe(original?.sourceRevision);
		expect(updated?.events).toEqual(original?.events);
		const schema = new Database(databasePath);
		try {
			for (const column of [
				"version",
				"tokens_reasoning",
				"tokens_cache_write",
				"time_archived",
				"agent",
			])
				schema.exec(`ALTER TABLE session DROP COLUMN ${column}`);
			schema.exec("ALTER TABLE part DROP COLUMN time_updated");
		} finally {
			schema.close();
		}
		const narrowed = await adapter.sessions.resolve("opencode.ses_fixture");
		expect(narrowed?.sourceRevision).toBe(original?.sourceRevision);
		expect(narrowed?.events).toEqual(original?.events);
	});

	test("invalidates the source revision for metadata changes and refuses rewritten content", async () => {
		const { adapter, databasePath } = fixtureDatabase();
		const context = { streaming: true, signal: new AbortController().signal };
		const original = await adapter.sessions.resolve("opencode.ses_fixture", context);
		expect(original?.readEvents).toBeDefined();
		const db = new Database(databasePath);
		try {
			db.run("UPDATE session SET title='Updated title', tokens_input=999 WHERE id='ses_fixture'");
		} finally {
			db.close();
		}
		const current = await adapter.sessions.resolve("opencode.ses_fixture", context);
		expect(current?.sourceRevision).not.toBe(original?.sourceRevision);
		expect(current?.summary).toBe("Updated title");
		const writer = new Database(databasePath);
		try {
			writer.run("UPDATE part SET data=? WHERE id='prt_001'", [
				JSON.stringify({ type: "text", text: "Rewritten" }),
			]);
		} finally {
			writer.close();
		}
		const read = async () => {
			for await (const _event of current?.readEvents?.() ?? []) {
			}
		};
		await expect(read()).rejects.toThrow("OpenCode source changed");
	});
	test("follows the official XDG default and relative database override", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-opencode-paths-"));
		temporaryRoots.push(root);
		delete process.env.OPENCODE_DB;
		process.env.XDG_DATA_HOME = root;
		const adapter = new OpenCodeAdapter();
		expect(adapter.sessions.watchPaths()[0]).toBe(join(root, "opencode", "opencode.db"));

		process.env.OPENCODE_DB = "work.db";
		expect(adapter.sessions.watchPaths()[0]).toBe(join(root, "opencode", "work.db"));
	});

	test("maps the official SQLite store to complete private events and a useful projection", async () => {
		const { adapter, databasePath } = fixtureDatabase();
		expect(await adapter.detect()).toBe(true);
		expect("skills" in adapter).toBe(false);
		expect(adapter.sessions.watchPaths()).toEqual([
			databasePath,
			`${databasePath}-wal`,
			`${databasePath}-journal`,
		]);

		const scan = await adapter.sessions.collect({ kind: "complete" });
		expect(scan).toMatchObject({ coverage: "complete", dedupedCount: 0 });
		expect(scan.sessions).toHaveLength(1);
		const session = scan.sessions[0];
		expect(session).toMatchObject({
			localSessionId: "opencode.ses_fixture",
			projectPath: "/workspace/opencode",
			messageCount: 2,
			inputTokens: 120,
			outputTokens: 42,
			cacheReadTokens: 9,
			model: "claude-sonnet-4-5",
			modelsUsed: ["claude-sonnet-4-5"],
			summary: "Inspect this workspace",
		});
		expect(session?.events?.every((event, index) => event.seq === index)).toBe(true);
		expect(session?.events).toContainEqual(
			expect.objectContaining({
				type: "reasoning",
				parts: [{ type: "text", text: "Private OpenCode reasoning" }],
				payload_json: '{"details":{"anthropic":{"signature":"opaque-signature"}}}',
			}),
		);
		expect(session?.events).toContainEqual(
			expect.objectContaining({
				type: "tool_call",
				call_id: "call_read",
				name: "read",
				arguments_json:
					'{"apiKey":"tool-input-preserved","filePath":"/workspace/opencode/README.md"}',
			}),
		);
		expect(session?.events).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				call_id: "call_read",
				status: "completed",
				parts: expect.arrayContaining([
					{ type: "text", text: "Tool output" },
					expect.objectContaining({
						type: "attachment",
						availability: "metadata_only",
						name: "preview.png",
					}),
				]),
				result_json: '{"lines":12}',
			}),
		);
		expect(session?.events).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				call_id: "call_shell",
				status: "error",
			}),
		);
		const serialized = JSON.stringify(session?.events);
		expect(serialized).toContain("Private OpenCode system instruction");
		expect(serialized).toContain("Internal ignored separator");
		const stepFinish = session?.events?.find(
			(event) => event.semantics?.display_kind === "step_finish",
		);
		expect(stepFinish).toMatchObject({
			type: "message",
			parts: [expect.objectContaining({ text: expect.stringContaining('"reasoning":18') })],
		});
		expect(serialized).not.toContain("must-not-upload");
		expect(serialized).not.toContain("/private/output/preview.png");
		expect(serialized).not.toContain("/private/workspace/secret.ts");
		expect(serialized).not.toContain("private-snapshot-hash");
		expect(JSON.stringify(session?.messages)).not.toContain("Private OpenCode reasoning");
		expect(JSON.stringify(session?.messages)).not.toContain("Internal ignored separator");
		expect(session?.messages.map((message) => message.content)).toEqual([
			"Inspect this workspace",
			"Visible OpenCode answer",
		]);
	});

	test("resolves one current session without a stale in-memory snapshot", async () => {
		const { adapter, databasePath } = fixtureDatabase();
		const before = await adapter.sessions.resolve("opencode.ses_fixture");
		const previousIds = before?.events?.map((event) => event.event_id) ?? [];
		const db = new Database(databasePath);
		const now = Date.parse("2026-08-27T10:00:06.000Z");
		insertJson(db, "part", [
			"prt_010",
			"msg_assistant",
			"ses_fixture",
			now,
			now,
			JSON.stringify({ type: "text", text: "Fresh backing-store answer" }),
		]);
		db.close();

		const after = await adapter.sessions.resolve("ses_fixture");
		expect(after?.events?.slice(0, previousIds.length).map((event) => event.event_id)).toEqual(
			previousIds,
		);
		expect(after?.messages.at(-1)?.content).toBe("Fresh backing-store answer");
		expect(await adapter.sessions.resolve("opencode.missing")).toBeNull();
	});
});
