import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		expect(adapter.getSessionsWatchPaths()).toEqual([join(tmpHome, ".codex", "sessions")]);
	});

	it("parses the fixture session with session_meta + turn_context + messages + token_count", async () => {
		const a = new CodexAdapter();
		const { sessions } = await a.collectSessions();
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

	it("filters by projectFilter", async () => {
		const a = new CodexAdapter();
		expect(
			(await a.collectSessions({ projectFilter: "/Users/fixture/project" })).sessions,
		).toHaveLength(1);
		expect(
			(await a.collectSessions({ projectFilter: "/Users/other/project" })).sessions,
		).toHaveLength(0);
	});

	it("returns empty when sessions dir is missing", async () => {
		rmSync(join(tmpHome, ".codex", "sessions"), { recursive: true, force: true });
		const a = new CodexAdapter();
		expect((await a.collectSessions()).sessions).toEqual([]);
	});

	it("summary skips <environment_context> prefix user messages", async () => {
		const a = new CodexAdapter();
		const s = (await a.collectSessions()).sessions[0]!;
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
			(await adapter.collectSessions()).sessions.map((session) => session.localSessionId),
		).toEqual(["019ae46c-52d9-7e51-9527-1b105eb42d1b", "019ae46c-52d9-7e51-9527-1b105eb42d2c"]);
		expect(adapter.getSessionsWatchPaths()).toEqual([
			join(tmpHome, ".codex", "sessions"),
			archivedRoot,
		]);
		expect(
			(await adapter.collectSessionsForPaths([archivedPath]))?.sessions.map(
				(session) => session.localSessionId,
			),
		).toEqual(["019ae46c-52d9-7e51-9527-1b105eb42d2c"]);
	});
});

describe("CodexAdapter.collectSkills", () => {
	it("finds non-dot skills, skips .system (dot prefix) and SKIP_DIRS", async () => {
		const a = new CodexAdapter();
		const skills = await a.collectSkills();
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
		await a.writeSkillArchive("demo", bytes);

		const extracted = join(tmpHome, ".codex", "skills", "demo", "SKILL.md");
		expect(existsSync(extracted)).toBe(true);
		expect(readFileSync(extracted, "utf-8")).toContain("name: demo");
	});
});

describe("CodexAdapter.buildRunCommand", () => {
	it("prefixes args with codex", () => {
		const a = new CodexAdapter();
		expect(a.buildRunCommand(["exec"], {})).toEqual(["codex", "exec"]);
	});
});
