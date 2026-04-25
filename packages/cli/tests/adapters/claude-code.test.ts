import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code";
import { tarSkillDir } from "../../src/lib/tar";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origConfigDir: string | undefined;
let origPath: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origConfigDir = process.env.CLAUDE_CONFIG_DIR;
	origPath = process.env.PATH;
	delete process.env.CLAUDE_CONFIG_DIR;
	tmpHome = copyFixtureToTmp("claude-code");
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origConfigDir) process.env.CLAUDE_CONFIG_DIR = origConfigDir;
	else delete process.env.CLAUDE_CONFIG_DIR;
	if (origPath !== undefined) process.env.PATH = origPath;
	cleanupTmp(tmpHome);
});

describe("ClaudeCodeAdapter.detect", () => {
	it("returns true when $HOME/.claude exists", async () => {
		const a = new ClaudeCodeAdapter();
		expect(await a.detect()).toBe(true);
	});

	it("returns false when $HOME/.claude is absent and `claude` binary is unreachable", async () => {
		process.env.HOME = `/tmp/clawdi-nowhere-${Date.now()}`;
		const a = new ClaudeCodeAdapter();
		// Stub the binary-fallback to fail (CI/dev machines often have `claude`
		// in PATH; `process.env.PATH = ""` doesn't reliably hide it because
		// child_process inherits a cached env on some platforms).
		(a as { getVersion: () => Promise<string | null> }).getVersion = async () => null;
		expect(await a.detect()).toBe(false);
	});

	it("falls back to `claude --version` when the home dir has no artifacts", async () => {
		// Bare `~/.claude/` with no artifacts shouldn't false-positive — but a
		// reachable `claude` binary still indicates a real install.
		const bareHome = `${tmpHome}-bare`;
		const { mkdirSync, rmSync } = await import("node:fs");
		mkdirSync(join(bareHome, ".claude"), { recursive: true });
		process.env.HOME = bareHome;

		const a = new ClaudeCodeAdapter();
		(a as { getVersion: () => Promise<string | null> }).getVersion = async () => null;
		expect(await a.detect()).toBe(false);
		(a as { getVersion: () => Promise<string | null> }).getVersion = async () => "claude 0.1.0";
		expect(await a.detect()).toBe(true);
		rmSync(bareHome, { recursive: true, force: true });
	});

	it("honors $CLAUDE_CONFIG_DIR override", async () => {
		process.env.HOME = `/tmp/clawdi-nowhere-${Date.now()}`;
		process.env.CLAUDE_CONFIG_DIR = join(tmpHome, ".claude");
		const a = new ClaudeCodeAdapter();
		expect(await a.detect()).toBe(true);
	});
});

describe("ClaudeCodeAdapter.collectSessions", () => {
	it("parses the fixture session with correct tokens and model", async () => {
		const a = new ClaudeCodeAdapter();
		const sessions = await a.collectSessions();
		expect(sessions).toHaveLength(1);
		const s = sessions[0]!;
		expect(s).toMatchObject({
			localSessionId: "11111111-2222-3333-4444-555555555555",
			projectPath: "/Users/fixture/project",
			model: "claude-opus-4-7",
			messageCount: 4, // 2 user + 2 assistant with non-empty text
			inputTokens: 30, // 10 + 20
			outputTokens: 8, // 5 + 3
			cacheReadTokens: 7, // 2 + 5
		});
		expect(s.modelsUsed).toEqual(["claude-opus-4-7"]);
		expect(s.startedAt.toISOString()).toBe("2026-04-20T10:00:00.000Z");
		expect(s.endedAt?.toISOString()).toBe("2026-04-20T10:00:05.000Z");
		expect(s.durationSeconds).toBe(5);
	});

	it("extracts text from array content blocks (type:text)", async () => {
		const a = new ClaudeCodeAdapter();
		const sessions = await a.collectSessions();
		const texts = sessions[0]?.messages.map((m) => m.content);
		expect(texts).toEqual(["hello", "world", "one more", "done"]);
	});

	it("filters by since", async () => {
		const a = new ClaudeCodeAdapter();
		// fixture starts at 2026-04-20T10:00:00Z
		const future = new Date("2026-05-01T00:00:00Z");
		expect(await a.collectSessions(future)).toHaveLength(0);
	});

	it("filters by projectFilter (matching cwd → encoded dir)", async () => {
		const a = new ClaudeCodeAdapter();
		const matched = await a.collectSessions(undefined, "/Users/fixture/project");
		expect(matched).toHaveLength(1);
		const notMatched = await a.collectSessions(undefined, "/Users/other/project");
		expect(notMatched).toHaveLength(0);
	});

	it("skips sessions with fewer than 3 JSONL lines", async () => {
		const shortPath = join(tmpHome, ".claude", "projects", "-Users-fixture-project", "short.jsonl");
		writeFileSync(shortPath, `${JSON.stringify({ timestamp: "2026-04-20T10:00:00Z" })}\n`);
		const a = new ClaudeCodeAdapter();
		const sessions = await a.collectSessions();
		// original long session still counts, short file is skipped
		expect(sessions).toHaveLength(1);
	});

	it("first user message populates the summary (capped at 200 chars)", async () => {
		const a = new ClaudeCodeAdapter();
		const s = (await a.collectSessions())[0]!;
		expect(s.summary).toBe("hello");
	});
});

describe("ClaudeCodeAdapter.collectSkills", () => {
	it("finds top-level skill directories with SKILL.md and skips SKIP_DIRS", async () => {
		const a = new ClaudeCodeAdapter();
		const skills = await a.collectSkills();
		const keys = skills.map((s) => s.skillKey).sort();
		// `node_modules` sits in the fixture as a negative case — the SKIP_DIRS
		// filter must drop it. `demo` is the one real skill.
		expect(keys).toEqual(["demo"]);
		const demo = skills.find((s) => s.skillKey === "demo")!;
		expect(demo.content).toContain("description: A demo skill");
		expect(demo.filePath).toContain("/.claude/skills/demo/SKILL.md");
	});
});

describe("ClaudeCodeAdapter.writeSkillArchive + getSkillPath", () => {
	it("round-trips a tar.gz (key matches archive internal dirname)", async () => {
		const src = join(tmpHome, ".claude", "skills", "demo");
		const bytes = await tarSkillDir(src);

		const a = new ClaudeCodeAdapter();
		await a.writeSkillArchive("demo", bytes);

		const extracted = join(tmpHome, ".claude", "skills", "demo", "SKILL.md");
		expect(existsSync(extracted)).toBe(true);
		expect(readFileSync(extracted, "utf-8")).toContain("name: demo");
	});

	it("getSkillPath returns skills/<key>/SKILL.md under Claude home", () => {
		const a = new ClaudeCodeAdapter();
		expect(a.getSkillPath("xyz")).toBe(join(tmpHome, ".claude", "skills", "xyz", "SKILL.md"));
	});
});

describe("ClaudeCodeAdapter.buildRunCommand", () => {
	it("prefixes args with claude", () => {
		const a = new ClaudeCodeAdapter();
		expect(a.buildRunCommand(["--help"], {})).toEqual(["claude", "--help"]);
	});
});
