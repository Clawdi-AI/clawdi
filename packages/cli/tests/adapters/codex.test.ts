import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type RawSession,
	type SessionScanRequest,
	scanSessionModule,
} from "../../src/adapters/base";
import { CodexAdapter } from "../../src/adapters/codex";
import { SESSION_PROJECTION_REVISION } from "../../src/adapters/rich-event-mapping";
import {
	assertProjectionGolden,
	assertSessionGolden,
} from "../../src/adapters/session-golden.test-support";
import {
	JsonlSessionSource,
	jsonlStatRevision,
	SESSION_RECORD_MAX_BYTES,
} from "../../src/adapters/session-source";
import { prepareSessionUpload } from "../../src/lib/session-upload";
import { tarSkillDir } from "../../src/lib/tar";
import attachmentNameFixtures from "../fixtures/codex-attachment-names.json";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origCodexHome: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origCodexHome = process.env.CODEX_HOME;
	delete process.env.CODEX_HOME;
	tmpHome = copyFixtureToTmp("codex");
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origCodexHome) process.env.CODEX_HOME = origCodexHome;
	else delete process.env.CODEX_HOME;
	cleanupTmp(tmpHome);
});

describe("CodexAdapter.detect", () => {
	it("returns true when $HOME/.codex exists", async () => {
		const a = new CodexAdapter();
		expect(await a.detect()).toBe(true);
	});

	it("honors $CODEX_HOME override", async () => {
		process.env.HOME = `/tmp/clawdi-nowhere-${Date.now()}`;
		process.env.CODEX_HOME = join(tmpHome, ".codex");
		const a = new CodexAdapter();
		expect(await a.detect()).toBe(true);
	});
});

describe("CodexAdapter.collectSessions", () => {
	it("skips an oversized JSONL file while reporting a scan issue", async () => {
		const oversized = join(tmpHome, ".codex", "sessions", "oversized.jsonl");
		writeFileSync(
			oversized,
			`{"type":"session_meta","payload":{"id":"oversized"}}\n{"text":"${"x".repeat(SESSION_RECORD_MAX_BYTES)}"}`,
		);
		const result = await new CodexAdapter().sessions.collect({ kind: "complete" });
		expect(result.sessions).toHaveLength(1);
		expect(result.scanIssues).toEqual([
			expect.objectContaining({
				path: oversized,
				reason: expect.stringContaining("source record exceeds"),
			}),
		]);
	});

	it("formats namespaced tool calls exactly like upstream ToolName Display", async () => {
		const adapter = new CodexAdapter();
		const original = (await adapter.sessions.collect({ kind: "complete" })).sessions[0];
		if (!original) throw new Error("expected Codex fixture session");
		appendFileSync(
			original.rawFilePath,
			readFileSync(join(import.meta.dir, "../fixtures/codex-namespace.jsonl"), "utf8"),
		);
		for (const streaming of [false, true]) {
			const session = await adapter.sessions.resolve(original.localSessionId, {
				streaming,
				signal: new AbortController().signal,
			});
			if (!session) throw new Error("expected namespaced Codex session");
			const upload = await prepareSessionUpload(session, "events-v1");
			const names: string[] = [];
			const events = [];
			for await (const event of upload.readEvents?.() ?? upload.events ?? []) {
				events.push(event);
				if (event.type === "tool_call") names.push(event.name);
			}
			expect(names).toEqual([
				"memory_search",
				"memory_search",
				"memory_search",
				"mcp__clawdimemory_search",
			]);
			assertProjectionGolden("codex-namespace", events);
		}
	});
	it("preserves origin/main session bytes and localHash", async () => {
		await assertSessionGolden("codex", new CodexAdapter().sessions, { statRevision: true });
	});
	it("maps sanitized attachment records to bounded basenames without losing the session", async () => {
		const adapter = new CodexAdapter();
		const original = (await adapter.sessions.collect({ kind: "complete" })).sessions[0];
		if (!original) throw new Error("expected Codex session fixture");
		appendFileSync(
			original.rawFilePath,
			`${attachmentNameFixtures.map((fixture) => JSON.stringify(fixture.record)).join("\n")}\n`,
		);

		const session = await adapter.sessions.resolve(original.localSessionId);
		if (!session?.events) throw new Error("expected mapped Codex events");
		for (const fixture of attachmentNameFixtures) {
			const attachments = session.events
				.filter((event) => event.source.record_id === fixture.record.payload.id)
				.flatMap((event) =>
					event.type === "message" || event.type === "tool_result" ? event.parts : [],
				)
				.filter((part) => part.type === "attachment");
			expect(attachments.map((part) => part.name ?? null)).toEqual(fixture.names);
			for (const attachment of attachments) {
				expect(Array.from(attachment.name ?? "").length).toBeLessThanOrEqual(512);
				expect(attachment.name ?? "").not.toContain("data:");
				expect(attachment.name ?? "").not.toContain("/synthetic/");
			}
		}
		expect(session.messages?.[0]).toMatchObject({ content: "hello" });
	});

	it("keeps fs watching on active sessions when archived_sessions is absent", () => {
		const adapter = new CodexAdapter();
		expect(existsSync(join(tmpHome, ".codex", "archived_sessions"))).toBe(false);
		expect(adapter.sessions.watchPaths()).toEqual([join(tmpHome, ".codex", "sessions")]);
	});

	it("parses the fixture session with session_meta + turn_context + messages + token_count", async () => {
		const a = new CodexAdapter();
		const { sessions } = await a.sessions.collect({ kind: "complete" });
		expect(sessions).toHaveLength(1);
		const s = sessions[0]!;
		expect(s).toMatchObject({
			localSessionId: "019ae46c-52d9-7e51-9527-1b105eb42d1b",
			projectPath: "/Users/fixture/project",
			model: "gpt-5.3-codex",
			messageCount: 2,
			inputTokens: 15,
			outputTokens: 7,
			cacheReadTokens: 3,
		});
		expect(s.modelsUsed).toEqual(["gpt-5.3-codex"]);
		expect(s.messages).toHaveLength(2);
		expect(s.messages[0]!).toMatchObject({ role: "user", content: "hello" });
		expect(s.messages[1]!).toMatchObject({
			role: "assistant",
			content: "world",
			model: "gpt-5.3-codex",
		});
	});

	it("binds assistant events to the model active for their turn", async () => {
		const sessionPath = join(
			tmpHome,
			".codex",
			"sessions",
			"2026",
			"04",
			"20",
			"rollout-2026-04-20T10-00-00-019ae46c-52d9-7e51-9527-1b105eb42d1b.jsonl",
		);
		appendFileSync(
			sessionPath,
			`${[
				{
					timestamp: "2026-04-20T10:00:05Z",
					type: "response_item",
					payload: {
						type: "function_call",
						call_id: "call-before-change",
						name: "before_change",
						arguments: "{}",
					},
				},
				{
					timestamp: "2026-04-20T10:00:06Z",
					type: "turn_context",
					payload: { model: "gpt-5.4" },
				},
				{
					timestamp: "2026-04-20T10:00:07Z",
					type: "response_item",
					payload: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "new model" }],
					},
				},
			]
				.map((item) => JSON.stringify(item))
				.join("\n")}\n`,
		);

		const session = (await new CodexAdapter().sessions.collect({ kind: "complete" })).sessions[0];
		expect(session?.events).toContainEqual(
			expect.objectContaining({
				type: "tool_call",
				call_id: "call-before-change",
				model: "gpt-5.3-codex",
			}),
		);
		expect(session?.events).toContainEqual(
			expect.objectContaining({
				type: "message",
				role: "assistant",
				parts: [{ type: "text", text: "new model" }],
				model: "gpt-5.4",
			}),
		);
		expect(session?.modelsUsed).toEqual(["gpt-5.3-codex", "gpt-5.4"]);
	});

	it("filters by projectFilter", async () => {
		const a = new CodexAdapter();
		expect(
			(await a.sessions.collect({ kind: "complete", projectFilter: "/Users/fixture/project" }))
				.sessions,
		).toHaveLength(1);
		expect(
			(await a.sessions.collect({ kind: "complete", projectFilter: "/Users/other/project" }))
				.sessions,
		).toHaveLength(0);
	});

	it("returns empty when sessions dir is missing", async () => {
		rmSync(join(tmpHome, ".codex", "sessions"), { recursive: true, force: true });
		const a = new CodexAdapter();
		expect((await a.sessions.collect({ kind: "complete" })).sessions).toEqual([]);
	});

	it("skips malformed project metadata during filtered scans", async () => {
		const path = join(tmpHome, ".codex", "sessions", "invalid-project.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({ type: "session_meta", payload: { id: "invalid", cwd: 123 } })}\n`,
		);
		const adapter = new CodexAdapter();
		expect(
			(
				await adapter.sessions.collect({
					kind: "complete",
					projectFilter: "/Users/fixture/project",
				})
			).sessions,
		).toHaveLength(1);
		expect(
			(
				await adapter.sessions.collect({
					kind: "paths",
					paths: [path],
					projectFilter: "/Users/fixture/project",
				})
			).sessions,
		).toEqual([]);
	});

	it("summary skips <environment_context> prefix user messages", async () => {
		const a = new CodexAdapter();
		const s = (await a.sessions.collect({ kind: "complete" })).sessions[0]!;
		// First non-environment_context user message is "hello"
		expect(s.summary).toBe("hello");
	});

	it("discovers archived sessions and parses only concrete changed transcripts", async () => {
		const activePath = join(
			tmpHome,
			".codex",
			"sessions",
			"2026",
			"04",
			"20",
			"rollout-2026-04-20T10-00-00-019ae46c-52d9-7e51-9527-1b105eb42d1b.jsonl",
		);
		const archivedRoot = join(tmpHome, ".codex", "archived_sessions");
		const archivedPath = join(archivedRoot, "rollout-archived.jsonl");
		mkdirSync(archivedRoot, { recursive: true });
		writeFileSync(
			archivedPath,
			readFileSync(activePath, "utf-8").replaceAll(
				"019ae46c-52d9-7e51-9527-1b105eb42d1b",
				"019ae46c-52d9-7e51-9527-1b105eb42d2c",
			),
		);

		const adapter = new CodexAdapter();
		expect(
			(await adapter.sessions.collect({ kind: "complete" })).sessions.map(
				(session) => session.localSessionId,
			),
		).toEqual(["019ae46c-52d9-7e51-9527-1b105eb42d1b", "019ae46c-52d9-7e51-9527-1b105eb42d2c"]);
		expect(adapter.sessions.watchPaths()).toEqual([
			join(tmpHome, ".codex", "sessions"),
			archivedRoot,
		]);
		expect(
			(await adapter.sessions.collect({ kind: "paths", paths: [archivedPath] })).sessions.map(
				(session) => session.localSessionId,
			),
		).toEqual(["019ae46c-52d9-7e51-9527-1b105eb42d2c"]);
	});

	it("finds a learned active session after Codex archives it", async () => {
		const sessionId = "019ae46c-52d9-7e51-9527-1b105eb42d1b";
		const archivedPath = join(tmpHome, ".codex", "archived_sessions", "rollout-archived.jsonl");
		mkdirSync(join(tmpHome, ".codex", "archived_sessions"), { recursive: true });

		const adapter = new CodexAdapter();
		const learned = (await adapter.sessions.collect({ kind: "complete" })).sessions[0];
		if (!learned) throw new Error("expected Codex session fixture");
		expect(learned.localSessionId).toBe(sessionId);
		renameSync(learned.rawFilePath, archivedPath);

		expect(await adapter.sessions.resolve(sessionId)).toMatchObject({
			localSessionId: sessionId,
			rawFilePath: archivedPath,
		});
	});

	it("maps visible ResponseItems and their private reasoning without raw envelopes", async () => {
		const sessionPath = join(
			tmpHome,
			".codex",
			"sessions",
			"2026",
			"04",
			"20",
			"rollout-2026-04-20T10-00-00-019ae46c-52d9-7e51-9527-1b105eb42d1b.jsonl",
		);
		const imageData = Buffer.from("generated image").toString("base64");
		const items = [
			{
				timestamp: "2026-04-20T10:00:06Z",
				type: "response_item",
				payload: {
					type: "tool_search_call",
					call_id: "search-1",
					execution: "client",
					arguments: { query: "calendar" },
				},
			},
			{
				timestamp: "2026-04-20T10:00:07Z",
				type: "response_item",
				payload: {
					type: "tool_search_output",
					call_id: "search-1",
					status: "completed",
					execution: "client",
					tools: [{ type: "function", name: "calendar_create" }],
				},
			},
			{
				timestamp: "2026-04-20T10:00:08Z",
				type: "response_item",
				payload: {
					type: "image_generation_call",
					id: "ig_123",
					status: "completed",
					revised_prompt: "A blue square",
					result: imageData,
				},
			},
			{
				timestamp: "2026-04-20T10:00:09Z",
				type: "response_item",
				payload: {
					type: "reasoning",
					id: "rs_1",
					summary: [{ type: "summary_text", text: "private Codex reasoning" }],
					encrypted_content: "opaque Codex continuation",
				},
			},
			{
				timestamp: "2026-04-20T10:00:10Z",
				type: "response_item",
				payload: {
					type: "agent_message",
					id: "amsg_123",
					author: "planner",
					recipient: "worker",
					content: [
						{ type: "input_text", text: "visible handoff" },
						{ type: "encrypted_content", data: "opaque handoff continuation" },
					],
				},
			},
		];
		appendFileSync(sessionPath, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);

		const session = (await new CodexAdapter().sessions.collect({ kind: "complete" })).sessions[0];
		const events = session?.events ?? [];
		expect(events).toContainEqual(
			expect.objectContaining({ type: "tool_call", call_id: "search-1", name: "tool_search" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				call_id: "search-1",
				result_json:
					'{"execution":"client","tools":[{"name":"calendar_create","type":"function"}]}',
			}),
		);
		const imageResult = events.find(
			(event) => event.type === "tool_result" && event.name === "image_generation",
		);
		expect(imageResult).toMatchObject({
			type: "tool_result",
			parts: [
				{
					type: "attachment",
					availability: "metadata_only",
					media_type: "image/png",
				},
			],
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "message",
				role: "developer",
				parts: [{ type: "text", text: "[Agent message from planner to worker]\nvisible handoff" }],
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "reasoning",
				kind: "reasoning",
				parts: [{ type: "text", text: "private Codex reasoning" }],
				payload_json: '{"encrypted_content":"opaque Codex continuation"}',
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "reasoning",
				kind: "redacted",
				parts: [],
				payload_json: '{"encrypted_content":"opaque handoff continuation"}',
			}),
		);
		expect(JSON.stringify(events)).not.toContain(imageData);
	});
});

describe("CodexAdapter.collectSkills", () => {
	it("finds non-dot skills, skips .system (dot prefix) and SKIP_DIRS", async () => {
		const a = new CodexAdapter();
		const skills = await a.skills.collect();
		// `demo/` is the sole real skill; `.system/internal/` is skipped by the
		// dot-prefix rule; `node_modules/` is skipped by SKIP_DIRS. Fixture
		// includes both negative cases.
		expect(skills.map((s) => s.skillKey)).toEqual(["demo"]);
	});
});

describe("CodexAdapter.writeSkillArchive + getSkillPath", () => {
	it("round-trips a tar.gz into the skills dir", async () => {
		const bytes = await tarSkillDir(join(tmpHome, ".codex", "skills", "demo"));

		const a = new CodexAdapter();
		await a.skills.writeArchive("demo", bytes);

		const extracted = join(tmpHome, ".codex", "skills", "demo", "SKILL.md");
		expect(existsSync(extracted)).toBe(true);
		expect(readFileSync(extracted, "utf-8")).toContain("name: demo");
	});
});

async function scanCodex(
	adapter: CodexAdapter,
	known: ReadonlyMap<string, string> = new Map(),
	request: SessionScanRequest = { kind: "complete" },
) {
	const scan = await scanSessionModule(adapter.sessions, request, known);
	const batches = [];
	for await (const batch of scan.batches) batches.push(batch);
	expect(batches).toHaveLength(1);
	const batch = batches[0];
	if (!batch) throw new Error("expected Codex scan batch");
	return batch;
}

function confirmedCodex(sessions: RawSession[]): Map<string, string> {
	return new Map(
		sessions.flatMap((session) =>
			session.sourceRevision === undefined
				? []
				: [[session.localSessionId, session.sourceRevision]],
		),
	);
}

async function quietCodexFixture() {
	const adapter = new CodexAdapter();
	const original = (await adapter.sessions.collect({ kind: "complete" })).sessions[0];
	if (!original) throw new Error("expected Codex fixture");
	const past = new Date(Date.now() - 10_000);
	utimesSync(original.rawFilePath, past, past);
	const first = await scanCodex(adapter);
	return { adapter, file: original.rawFilePath, first, known: confirmedCodex(first.sessions) };
}

function codexForkFixture(childFirst = true) {
	const active = join(tmpHome, ".codex", "sessions");
	const archived = join(tmpHome, ".codex", "archived_sessions");
	rmSync(active, { recursive: true });
	const parent = {
		id: "019ae46c-52a7-7000-8000-000000000001",
		cwd: "/synthetic/parent",
		timestamp: "2026-10-08T18:00:00Z",
		file: join(childFirst ? archived : active, "rollout-parent.jsonl"),
	};
	const child = {
		id: "019ae46c-52a7-7000-8000-000000000002",
		cwd: "/synthetic/child",
		timestamp: "2026-10-08T19:00:00Z",
		file: join(childFirst ? active : archived, "rollout-child.jsonl"),
	};
	const parentMeta = {
		type: "session_meta",
		timestamp: parent.timestamp,
		payload: { id: parent.id, cwd: parent.cwd, timestamp: parent.timestamp },
	};
	const childMeta = {
		type: "session_meta",
		timestamp: child.timestamp,
		payload: {
			id: child.id,
			cwd: child.cwd,
			timestamp: child.timestamp,
			forked_from_id: parent.id,
		},
	};
	const message = (timestamp: string, role: "user" | "assistant", text: string) => ({
		type: "response_item",
		timestamp,
		payload: {
			type: "message",
			role,
			content: [{ type: role === "user" ? "input_text" : "output_text", text }],
		},
	});
	const parentRecords = [
		parentMeta,
		message("2026-10-08T18:00:01Z", "user", "Parent prompt"),
		message("2026-10-08T18:00:02Z", "assistant", "Parent answer"),
	];
	// Codex copied forks persist their own meta before the parent's complete rollout.
	const childRecords = [
		childMeta,
		...parentRecords,
		message("2026-10-08T19:00:01Z", "user", "Child prompt"),
		message("2026-10-08T19:00:02Z", "assistant", "Child answer"),
	];
	const past = new Date(Date.now() - 10_000);
	for (const [directory, file, records] of [
		[childFirst ? archived : active, parent.file, parentRecords],
		[childFirst ? active : archived, child.file, childRecords],
	] as const) {
		mkdirSync(directory, { recursive: true });
		writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		utimesSync(file, past, past);
	}
	return { parent, child };
}

async function assertCodexForkSessions(
	sessions: RawSession[],
	{ parent, child }: ReturnType<typeof codexForkFixture>,
) {
	expect(sessions).toHaveLength(2);
	const parentSession = sessions.find((session) => session.localSessionId === parent.id);
	const childSession = sessions.find((session) => session.localSessionId === child.id);
	for (const [session, fixture, messageCount] of [
		[parentSession, parent, 2],
		[childSession, child, 4],
	] as const) {
		expect(session).toMatchObject({
			localSessionId: fixture.id,
			projectPath: fixture.cwd,
			startedAt: new Date(fixture.timestamp),
			messageCount,
			summary: "Parent prompt",
			rawFilePath: fixture.file,
		});
		if (!session) throw new Error("expected fork session");
		const upload = await prepareSessionUpload(session, "events-v1");
		const contents: string[] = [];
		for await (const event of upload.readEvents?.() ?? upload.events ?? []) {
			expect(event.source.session_key).toBe(fixture.id);
			if (event.type === "message") {
				contents.push(
					event.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
				);
			}
		}
		expect(contents).toEqual(
			fixture === parent
				? ["Parent prompt", "Parent answer"]
				: ["Parent prompt", "Parent answer", "Child prompt", "Child answer"],
		);
	}
}

describe("CodexAdapter copied fork sessions", () => {
	for (const childFirst of [true, false]) {
		it(`emits each thread's own content and metadata with ${childFirst ? "child" : "parent"} visited first`, async () => {
			const fixture = codexForkFixture(childFirst);
			const result = await scanCodex(new CodexAdapter());
			expect(result.observedLocalSessionIds).toEqual(
				childFirst ? [fixture.child.id, fixture.parent.id] : [fixture.parent.id, fixture.child.id],
			);
			await assertCodexForkSessions(result.sessions, fixture);
		});
	}

	it("emits only the child when its parent file is absent", async () => {
		const { parent, child } = codexForkFixture();
		rmSync(parent.file);
		const result = await scanCodex(new CodexAdapter());
		expect(result.observedLocalSessionIds).toEqual([child.id]);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]).toMatchObject({
			localSessionId: child.id,
			projectPath: child.cwd,
			startedAt: new Date(child.timestamp),
			messageCount: 4,
		});
	});

	it("re-parses a legacy lock that confirmed a child file under its parent id", async () => {
		const fixture = codexForkFixture();
		const legacyRevision = jsonlStatRevision(statSync(fixture.child.file, { bigint: true }));
		if (!legacyRevision) throw new Error("expected a stable child file stat revision");
		const result = await scanCodex(
			new CodexAdapter(),
			new Map([[fixture.parent.id, legacyRevision]]),
		);
		expect(result.observedLocalSessionIds).toEqual([fixture.child.id, fixture.parent.id]);
		await assertCodexForkSessions(result.sessions, fixture);
	});

	it("skips both confirmed threads and stops observing a deleted parent", async () => {
		const { parent, child } = codexForkFixture();
		const adapter = new CodexAdapter();
		const first = await scanCodex(adapter);
		const known = confirmedCodex(first.sessions);
		expect(known.size).toBe(2);
		const warm = await scanCodex(adapter, known);
		expect(warm.sessions).toHaveLength(0);
		expect(warm.observedLocalSessionIds).toEqual([child.id, parent.id]);
		rmSync(parent.file);
		const deleted = await scanCodex(adapter, known);
		expect(deleted.sessions).toHaveLength(0);
		expect(deleted.observedLocalSessionIds).toEqual([child.id]);
		expect(await adapter.sessions.resolve(parent.id)).toBeNull();
	});

	it("resolves the parent and child to their own sessions after a warm scan", async () => {
		const fixture = codexForkFixture();
		const first = await scanCodex(new CodexAdapter());
		const adapter = new CodexAdapter();
		await scanCodex(adapter, confirmedCodex(first.sessions));
		const parent = await adapter.sessions.resolve(fixture.parent.id);
		const child = await adapter.sessions.resolve(fixture.child.id);
		if (!parent || !child) throw new Error("expected both fork sessions to resolve");
		await assertCodexForkSessions([parent, child], fixture);
	});

	it("does not take a copied parent's id when the first meta has no id", async () => {
		const { parent, child } = codexForkFixture();
		rmSync(parent.file);
		const records = readFileSync(child.file, "utf8").trimEnd().split("\n");
		records[0] = JSON.stringify({
			type: "session_meta",
			timestamp: child.timestamp,
			payload: { cwd: child.cwd, timestamp: child.timestamp },
		});
		writeFileSync(child.file, `${records.join("\n")}\n`);
		const result = await scanCodex(new CodexAdapter());
		expect(result.sessions).toHaveLength(0);
		expect(result.observedLocalSessionIds).toEqual([]);
	});
});

describe("CodexAdapter stat-skip scans", () => {
	it("skips confirmed files without opening the parser, including paths and restart scans", async () => {
		const { file, first, known } = await quietCodexFixture();
		const adapter = new CodexAdapter();
		const parser = spyOn(JsonlSessionSource, "open");
		try {
			for (const request of [
				{ kind: "complete" } as const,
				{ kind: "paths", paths: [file] } as const,
			]) {
				parser.mockClear();
				const result = await scanCodex(adapter, known, request);
				expect(result.sessions).toHaveLength(known.size ? 0 : 1);
				expect(result.observedLocalSessionIds).toEqual(first.observedLocalSessionIds);
				if (known.size) expect(parser).not.toHaveBeenCalled();
				else expect(parser).toHaveBeenCalled();
			}
			const filtered = await scanCodex(adapter, known, {
				kind: "complete",
				projectFilter: "/Users/fixture/project",
			});
			expect(filtered.sessions).toHaveLength(1);
			expect((await adapter.sessions.collect({ kind: "complete" })).sessions).toHaveLength(1);
		} finally {
			parser.mockRestore();
		}
	});

	it("re-parses appended content", async () => {
		const { adapter, file, first, known } = await quietCodexFixture();
		appendFileSync(
			file,
			`${JSON.stringify({
				type: "response_item",
				timestamp: "2026-04-20T10:01:00Z",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "appended" }],
				},
			})}\n`,
		);
		const past = new Date(Date.now() - 10_000);
		utimesSync(file, past, past);
		const result = await scanCodex(adapter, known);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]?.messageCount).toBe((first.sessions[0]?.messageCount ?? 0) + 1);
		if (known.size)
			expect(result.sessions[0]?.sourceRevision).not.toBe(first.sessions[0]?.sourceRevision);
	});

	it("detects a same-size rewrite after mtime is restored", async () => {
		const { adapter, file, known } = await quietCodexFixture();
		const content = readFileSync(file, "utf8");
		const past = new Date(Date.now() - 10_000);
		utimesSync(file, past, past);
		const before = await scanCodex(adapter);
		await Bun.sleep(20);
		const rewritten = content.replace("hello", "world");
		expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(content));
		writeFileSync(file, rewritten);
		utimesSync(file, past, past);
		const result = await scanCodex(adapter, confirmedCodex(before.sessions));
		expect(result.sessions).toHaveLength(1);
		const session = result.sessions[0];
		if (!session) throw new Error("expected rewritten Codex fixture");
		expect(session.summary).toBe("world");
		const upload = await prepareSessionUpload(session, "events-v1");
		const events = [];
		for await (const event of upload.readEvents?.() ?? upload.events ?? []) events.push(event);
		expect(JSON.stringify(events)).toContain("world");
		if (known.size)
			expect(result.sessions[0]?.sourceRevision).not.toBe(before.sessions[0]?.sourceRevision);
	});

	it("never skips recent or future files even with a matching stat fingerprint", async () => {
		const { adapter, file } = await quietCodexFixture();
		for (const mtime of [new Date(), new Date(Date.now() + 60_000)]) {
			utimesSync(file, mtime, mtime);
			const fresh = await scanCodex(adapter);
			expect(fresh.sessions[0]?.sourceRevision).toBeUndefined();
			const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
			let known: Map<string, string>;
			try {
				known = confirmedCodex((await scanCodex(adapter)).sessions);
			} finally {
				clock.mockRestore();
			}
			const result = await scanCodex(adapter, known);
			expect(result.sessions).toHaveLength(1);
			expect(result.sessions[0]?.sourceRevision).toBeUndefined();
		}
	});

	it("re-parses old digest and projection revisions once before skipping confirmed state", async () => {
		const { adapter, first, known } = await quietCodexFixture();
		const session = first.sessions[0];
		if (!session) throw new Error("expected Codex fixture session");
		const oldRevisions = ["jsonl-v1:42:old-digest"];
		if (session.sourceRevision)
			oldRevisions.push(
				session.sourceRevision.replace(
					`p${SESSION_PROJECTION_REVISION}:`,
					`p${SESSION_PROJECTION_REVISION - 1}:`,
				),
			);
		for (const revision of oldRevisions) {
			const migrated = await scanCodex(adapter, new Map([[session.localSessionId, revision]]));
			expect(migrated.sessions).toHaveLength(1);
			if (known.size) expect(migrated.sessions[0]?.sourceRevision).toBe(session.sourceRevision);
			const next = await scanCodex(adapter, confirmedCodex(migrated.sessions));
			expect(next.sessions).toHaveLength(known.size ? 0 : 1);
		}
	});

	it("refreshes archived paths for skipped sessions and handles deletion", async () => {
		const { adapter, file, first, known } = await quietCodexFixture();
		const sessionId = first.observedLocalSessionIds[0];
		if (!sessionId) throw new Error("expected Codex fixture id");
		const archived = join(tmpHome, ".codex", "archived_sessions", "moved.jsonl");
		mkdirSync(join(tmpHome, ".codex", "archived_sessions"), { recursive: true });
		renameSync(file, archived);
		const moved = await scanCodex(adapter, known);
		expect(moved.observedLocalSessionIds).toEqual([sessionId]);
		const updated = moved.sessions.length ? confirmedCodex(moved.sessions) : known;
		const restarted = new CodexAdapter();
		await scanCodex(restarted, updated);
		expect((await restarted.sessions.resolve(sessionId))?.rawFilePath).toBe(archived);
		rmSync(archived);
		expect(
			(await scanCodex(restarted, updated, { kind: "paths", paths: [archived] }))
				.observedLocalSessionIds,
		).toEqual([]);
		expect((await scanCodex(restarted, updated)).observedLocalSessionIds).toEqual([]);
		expect(await restarted.sessions.resolve(sessionId)).toBeNull();
	});
});
