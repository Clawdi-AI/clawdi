import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenClawAdapter } from "../../src/adapters/openclaw";
import { tarSkillDir } from "../../src/lib/tar";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origStateDir: string | undefined;
let origAgentId: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origStateDir = process.env.OPENCLAW_STATE_DIR;
	origAgentId = process.env.OPENCLAW_AGENT_ID;
	delete process.env.OPENCLAW_STATE_DIR;
	delete process.env.OPENCLAW_AGENT_ID;
	tmpHome = copyFixtureToTmp("openclaw");
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origStateDir) process.env.OPENCLAW_STATE_DIR = origStateDir;
	else delete process.env.OPENCLAW_STATE_DIR;
	if (origAgentId) process.env.OPENCLAW_AGENT_ID = origAgentId;
	else delete process.env.OPENCLAW_AGENT_ID;
	cleanupTmp(tmpHome);
});

/**
 * Drop a second agent (`financial`) into the fixture with one session — used
 * to verify the multi-agent scanning fix from issue #28.
 */
function addFinancialAgent(stateRoot: string, sessionId = "oc-financial-001") {
	const agentRoot = join(stateRoot, "agents", "financial");
	mkdirSync(join(agentRoot, "sessions"), { recursive: true });
	mkdirSync(join(agentRoot, "skills", "fin-skill"), { recursive: true });
	writeFileSync(
		join(agentRoot, "sessions", "sessions.json"),
		JSON.stringify({
			[sessionId]: {
				sessionId,
				updatedAt: 1776247300000,
				sessionFile: `${sessionId}.jsonl`,
				model: "gpt-5.3-codex",
				inputTokens: 5,
				outputTokens: 3,
				cacheRead: 0,
				displayName: "Financial briefing",
				acp: { cwd: "/Users/fixture/finance", lastActivityAt: 1776247300000 },
			},
		}),
	);
	writeFileSync(
		join(agentRoot, "sessions", `${sessionId}.jsonl`),
		[
			JSON.stringify({
				type: "message",
				timestamp: 1776247200000,
				message: { role: "user", content: "stocks" },
			}),
			JSON.stringify({
				type: "message",
				timestamp: 1776247205000,
				message: { role: "assistant", content: "analyzing" },
			}),
		].join("\n"),
	);
	writeFileSync(
		join(agentRoot, "skills", "fin-skill", "SKILL.md"),
		"---\nname: fin-skill\ndescription: Finance assistant\n---\n",
	);
}

describe("OpenClawAdapter.detect", () => {
	it("returns true when $HOME/.openclaw exists", async () => {
		const a = new OpenClawAdapter();
		expect(await a.detect()).toBe(true);
	});

	it("detects alternative home names (.clawdbot / .moltbot) via getOpenClawHome", async () => {
		// Point HOME to a dir that has .clawdbot but not .openclaw, with a
		// real agent dir inside so the stricter detect() (sessions index OR
		// agent dir) recognizes it as a usable install.
		const alt = `${tmpHome}-alt`;
		mkdirSync(join(alt, ".clawdbot", "agents", "main"), { recursive: true });
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
		// Also remove the fixture's `agents/main` dir so listAgentDirs returns
		// no candidates. (Otherwise scanning continues over the dir, finds no
		// index, and short-circuits — same observable behavior, but only by
		// accident.)
		rmSync(join(tmpHome, ".openclaw", "agents", "main"), { recursive: true, force: true });
		const a = new OpenClawAdapter();
		expect(await a.collectSessions()).toEqual([]);
	});

	it("scans every agents/<id>/ subdir (issue #28)", async () => {
		// Default fixture has `main`. Drop in a second agent and confirm both
		// are picked up without setting OPENCLAW_AGENT_ID.
		addFinancialAgent(join(tmpHome, ".openclaw"));
		const a = new OpenClawAdapter();
		const sessions = await a.collectSessions();
		const ids = sessions.map((s) => s.localSessionId).sort();
		expect(ids).toEqual(["oc-financial-001", "oc-session-001"]);
	});

	it("OPENCLAW_AGENT_ID still narrows to a single agent", async () => {
		addFinancialAgent(join(tmpHome, ".openclaw"));
		process.env.OPENCLAW_AGENT_ID = "financial";
		const a = new OpenClawAdapter();
		const sessions = await a.collectSessions();
		expect(sessions.map((s) => s.localSessionId)).toEqual(["oc-financial-001"]);
	});
});

describe("OpenClawAdapter.collectSkills", () => {
	it("finds demo skill under agents/<id>/skills/ and skips SKIP_DIRS", async () => {
		const a = new OpenClawAdapter();
		const skills = await a.collectSkills();
		// Fixture has demo/ (real) and node_modules/ (SKIP_DIRS sentinel).
		expect(skills.map((s) => s.skillKey)).toEqual(["demo"]);
	});

	it("unions skills across agents/<id>/skills/ dirs (issue #28)", async () => {
		addFinancialAgent(join(tmpHome, ".openclaw"));
		const a = new OpenClawAdapter();
		const keys = (await a.collectSkills()).map((s) => s.skillKey).sort();
		expect(keys).toEqual(["demo", "fin-skill"]);
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
