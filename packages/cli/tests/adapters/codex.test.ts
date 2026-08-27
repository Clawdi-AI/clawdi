import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CodexAdapter } from "../../src/adapters/codex";
import { tarSkillDir } from "../../src/lib/tar";
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
