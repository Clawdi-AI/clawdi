import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
		const { sessions, dedupedCount } = await a.collectSessions();
		expect(sessions).toHaveLength(1);
		expect(dedupedCount).toBe(0);
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
		const { sessions } = await a.collectSessions();
		const texts = sessions[0]?.messages.map((m) => m.content);
		expect(texts).toEqual(["hello", "world", "one more", "done"]);
	});

	it("filters by projectFilter (matching cwd → encoded dir)", async () => {
		const a = new ClaudeCodeAdapter();
		const matched = await a.collectSessions({ projectFilter: "/Users/fixture/project" });
		expect(matched.sessions).toHaveLength(1);
		const notMatched = await a.collectSessions({ projectFilter: "/Users/other/project" });
		expect(notMatched.sessions).toHaveLength(0);
	});

	it("skips sessions with fewer than 3 JSONL lines", async () => {
		const shortPath = join(tmpHome, ".claude", "projects", "-Users-fixture-project", "short.jsonl");
		writeFileSync(shortPath, `${JSON.stringify({ timestamp: "2026-04-20T10:00:00Z" })}\n`);
		const a = new ClaudeCodeAdapter();
		const { sessions } = await a.collectSessions();
		// original long session still counts, short file is skipped
		expect(sessions).toHaveLength(1);
	});

	it("first user message populates the summary (capped at 200 chars)", async () => {
		const a = new ClaudeCodeAdapter();
		const s = (await a.collectSessions()).sessions[0]!;
		expect(s.summary).toBe("hello");
	});
});

/**
 * Build a Claude Code session jsonl with the given uuids. The first line is
 * the session-start meta; the rest alternate user/assistant messages so that
 * `parseSessionJsonl` produces a non-empty `messages` array. Each line carries
 * a `uuid` so the dedupe pass can compare uuid sets across files.
 */
function makeJsonl(opts: {
	sessionId: string;
	cwd: string;
	uuids: string[];
	startTimestamp?: string;
}): string {
	const { sessionId, cwd, uuids } = opts;
	const startTs = opts.startTimestamp ?? "2026-04-23T06:45:31.915Z";
	const lines: string[] = [];
	lines.push(
		JSON.stringify({
			type: "session-start",
			sessionId,
			cwd,
			timestamp: startTs,
			version: "1.0.0",
			uuid: uuids[0],
		}),
	);
	for (let i = 1; i < uuids.length; i++) {
		const role = i % 2 === 1 ? "user" : "assistant";
		const ts = `2026-04-23T06:45:${String(31 + (i % 28)).padStart(2, "0")}.000Z`;
		const message =
			role === "user"
				? { role: "user", content: `user msg ${i}` }
				: {
						role: "assistant",
						model: "claude-opus-4-7",
						content: [{ type: "text", text: `assistant msg ${i}` }],
						usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
					};
		lines.push(JSON.stringify({ type: role, sessionId, timestamp: ts, uuid: uuids[i], message }));
	}
	return `${lines.join("\n")}\n`;
}

function writeResumeSessionFile(opts: {
	cwd: string;
	sessionId: string;
	uuids: string[];
	startTimestamp?: string;
}) {
	const projectDirName = opts.cwd.replace(/\//g, "-");
	const projectDir = join(tmpHome, ".claude", "projects", projectDirName);
	mkdirSync(projectDir, { recursive: true });
	const file = join(projectDir, `${opts.sessionId}.jsonl`);
	writeFileSync(file, makeJsonl(opts));
}

function uuidRange(prefix: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
}

describe("ClaudeCodeAdapter dedupeResumeChains", () => {
	it("dedupes A when A.uuids ⊂ B.uuids in the same project (resume chain)", async () => {
		const cwd = "/Users/fixture/resume-test";
		const aUuids = uuidRange("u", 12);
		const bUuids = [...aUuids, ...uuidRange("v", 8)];

		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: aUuids });
		writeResumeSessionFile({
			cwd,
			sessionId: "bbbb-bbbb",
			uuids: bUuids,
			startTimestamp: "2026-04-24T04:40:43.360Z",
		});

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.collectSessions({ projectFilter: cwd });

		expect(result.dedupedCount).toBe(1);
		expect(result.sessions.map((s) => s.localSessionId)).toEqual(["bbbb-bbbb"]);
	});

	it("dedupes A and B in a 3-link chain A ⊂ B ⊂ C, keeping only C", async () => {
		const cwd = "/Users/fixture/resume-test-chain";
		const aUuids = uuidRange("u", 12);
		const bUuids = [...aUuids, ...uuidRange("v", 6)];
		const cUuids = [...bUuids, ...uuidRange("w", 4)];

		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: aUuids });
		writeResumeSessionFile({ cwd, sessionId: "bbbb-bbbb", uuids: bUuids });
		writeResumeSessionFile({ cwd, sessionId: "cccc-cccc", uuids: cUuids });

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.collectSessions({ projectFilter: cwd });

		expect(result.dedupedCount).toBe(2);
		expect(result.sessions.map((s) => s.localSessionId)).toEqual(["cccc-cccc"]);
	});

	it("does not dedupe across different projects even when uuid sets are subset", async () => {
		const aUuids = uuidRange("u", 12);
		const bUuids = [...aUuids, ...uuidRange("v", 8)];

		writeResumeSessionFile({
			cwd: "/Users/fixture/proj-cross-a",
			sessionId: "aaaa-aaaa",
			uuids: aUuids,
		});
		writeResumeSessionFile({
			cwd: "/Users/fixture/proj-cross-b",
			sessionId: "bbbb-bbbb",
			uuids: bUuids,
		});

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.collectSessions();
		// scope to just the two we wrote — the fixture's pre-existing session
		// would otherwise pad the result count
		const ours = result.sessions.filter((s) =>
			["aaaa-aaaa", "bbbb-bbbb"].includes(s.localSessionId),
		);

		expect(result.dedupedCount).toBe(0);
		expect(ours.map((s) => s.localSessionId).sort()).toEqual(["aaaa-aaaa", "bbbb-bbbb"]);
	});

	it("does not dedupe when A is missing even one uuid (not a strict subset)", async () => {
		const cwd = "/Users/fixture/resume-near-miss";
		const shared = uuidRange("u", 11);
		const aUuids = [...shared, "a-only-extra"];
		const bUuids = [...shared, "b-only-1", "b-only-2", "b-only-3"];

		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: aUuids });
		writeResumeSessionFile({ cwd, sessionId: "bbbb-bbbb", uuids: bUuids });

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.collectSessions({ projectFilter: cwd });

		expect(result.dedupedCount).toBe(0);
		expect(result.sessions.map((s) => s.localSessionId).sort()).toEqual(["aaaa-aaaa", "bbbb-bbbb"]);
	});

	it("does not consider sessions with fewer than 10 uuids as predecessors", async () => {
		const cwd = "/Users/fixture/resume-too-short";
		const aUuids = uuidRange("u", 5);
		const bUuids = [...aUuids, ...uuidRange("v", 15)];

		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: aUuids });
		writeResumeSessionFile({ cwd, sessionId: "bbbb-bbbb", uuids: bUuids });

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.collectSessions({ projectFilter: cwd });

		expect(result.dedupedCount).toBe(0);
		expect(result.sessions.map((s) => s.localSessionId).sort()).toEqual(["aaaa-aaaa", "bbbb-bbbb"]);
	});

	it("does not dedupe a single session in a project (group of 1)", async () => {
		const cwd = "/Users/fixture/resume-singleton";
		writeResumeSessionFile({ cwd, sessionId: "aaaa-aaaa", uuids: uuidRange("u", 15) });

		const adapter = new ClaudeCodeAdapter();
		const result = await adapter.collectSessions({ projectFilter: cwd });

		expect(result.dedupedCount).toBe(0);
		expect(result.sessions).toHaveLength(1);
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
