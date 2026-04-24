import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenClawAdapter } from "../../src/adapters/openclaw";
import { tarSkillDir } from "../../src/lib/tar";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origStateDir: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origStateDir = process.env.OPENCLAW_STATE_DIR;
	delete process.env.OPENCLAW_STATE_DIR;
	tmpHome = copyFixtureToTmp("openclaw");
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origStateDir) process.env.OPENCLAW_STATE_DIR = origStateDir;
	else delete process.env.OPENCLAW_STATE_DIR;
	cleanupTmp(tmpHome);
});

describe("OpenClawAdapter.detect", () => {
	it("returns true when $HOME/.openclaw exists", async () => {
		const a = new OpenClawAdapter();
		expect(await a.detect()).toBe(true);
	});

	it("detects alternative home names (.clawdbot / .moltbot) via getOpenClawHome", async () => {
		// Point HOME to a dir that has .clawdbot but not .openclaw
		const alt = `${tmpHome}-alt`;
		mkdirSync(join(alt, ".clawdbot"), { recursive: true });
		process.env.HOME = alt;
		const a = new OpenClawAdapter();
		expect(await a.detect()).toBe(true);
		// cleanup
		const { rmSync } = await import("node:fs");
		rmSync(alt, { recursive: true, force: true });
	});

	it("honors $OPENCLAW_STATE_DIR override", async () => {
		process.env.HOME = `/tmp/clawdi-nowhere-${Date.now()}`;
		process.env.OPENCLAW_STATE_DIR = join(tmpHome, ".openclaw");
		const a = new OpenClawAdapter();
		expect(await a.detect()).toBe(true);
	});
});

describe("OpenClawAdapter.collectSessions", () => {
	it("parses the fixture session with index metadata + transcript messages", async () => {
		const a = new OpenClawAdapter();
		const sessions = await a.collectSessions();
		expect(sessions).toHaveLength(1);
		const s = sessions[0]!;
		expect(s).toMatchObject({
			localSessionId: "oc-session-001",
			projectPath: "/Users/fixture/project",
			model: "claude-opus-4-7",
			messageCount: 2,
			inputTokens: 12,
			outputTokens: 6,
			cacheReadTokens: 2,
		});
		expect(s.messages).toHaveLength(2);
		expect(s.messages[0]!).toMatchObject({ role: "user", content: "hello" });
		expect(s.messages[1]!).toMatchObject({
			role: "assistant",
			content: "world",
			model: "claude-opus-4-7",
		});
	});

	it("uses displayName as summary", async () => {
		const a = new OpenClawAdapter();
		const s = (await a.collectSessions())[0]!;
		expect(s.summary).toBe("Fixture session");
	});

	it("filters by since (based on updatedAt)", async () => {
		const a = new OpenClawAdapter();
		const future = new Date("2026-05-01T00:00:00Z");
		expect(await a.collectSessions(future)).toHaveLength(0);
	});

	it("filters by projectFilter matching acp.cwd", async () => {
		const a = new OpenClawAdapter();
		expect(await a.collectSessions(undefined, "/Users/fixture/project")).toHaveLength(1);
		expect(await a.collectSessions(undefined, "/Users/other/project")).toHaveLength(0);
	});

	it("returns empty when sessions.json is missing", async () => {
		const { rmSync } = await import("node:fs");
		rmSync(join(tmpHome, ".openclaw", "agents", "main", "sessions", "sessions.json"));
		const a = new OpenClawAdapter();
		expect(await a.collectSessions()).toEqual([]);
	});
});

describe("OpenClawAdapter.collectSkills", () => {
	it("finds demo skill under agents/<id>/skills/ and skips SKIP_DIRS", async () => {
		const a = new OpenClawAdapter();
		const skills = await a.collectSkills();
		// Fixture has demo/ (real) and node_modules/ (SKIP_DIRS sentinel).
		expect(skills.map((s) => s.skillKey)).toEqual(["demo"]);
	});
});

describe("OpenClawAdapter.writeSkillArchive + getSkillPath", () => {
	it("round-trips a tar.gz into the agent skills dir", async () => {
		const bytes = await tarSkillDir(join(tmpHome, ".openclaw", "agents", "main", "skills", "demo"));

		const a = new OpenClawAdapter();
		await a.writeSkillArchive("demo", bytes);

		const extracted = join(tmpHome, ".openclaw", "agents", "main", "skills", "demo", "SKILL.md");
		expect(existsSync(extracted)).toBe(true);
		expect(readFileSync(extracted, "utf-8")).toContain("name: demo");
	});
});

describe("OpenClawAdapter.buildRunCommand", () => {
	it("prefixes args with openclaw", () => {
		const a = new OpenClawAdapter();
		expect(a.buildRunCommand(["run"], {})).toEqual(["openclaw", "run"]);
	});
});
