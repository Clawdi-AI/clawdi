import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HermesAdapter } from "../../src/adapters/hermes";
import { tarSkillDir } from "../../src/lib/tar";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	tmpHome = copyFixtureToTmp("hermes");
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
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
	it("returns the plain-string-model session with correct token counters", async () => {
		const a = new HermesAdapter();
		const { sessions } = await a.collectSessions();
		const plain = sessions.find((s) => s.localSessionId === "s-plain");
		expect(plain).toBeDefined();
		expect(plain).toMatchObject({
			localSessionId: "s-plain",
			projectPath: null, // Hermes has no cwd concept
			model: "claude-opus-4-7",
			messageCount: 2,
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 2,
		});
		expect(plain?.messages).toHaveLength(2);
		expect(plain?.messages[0]?.role).toBe("user");
		expect(plain?.messages[0]?.content).toBe("hello");
		expect(plain?.messages[1]?.role).toBe("assistant");
		expect(plain?.messages[1]?.model).toBe("claude-opus-4-7");
	});

	it("parses a JSON-blob model field via parseModelField", async () => {
		const a = new HermesAdapter();
		const { sessions } = await a.collectSessions();
		const json = sessions.find((s) => s.localSessionId === "s-json");
		expect(json).toBeDefined();
		expect(json?.model).toBe("gpt-5.3-codex");
		expect(json?.modelsUsed).toEqual(["gpt-5.3-codex"]);
	});

	it("skips sessions with no extractable messages", async () => {
		const a = new HermesAdapter();
		const { sessions } = await a.collectSessions();
		expect(sessions.find((s) => s.localSessionId === "s-empty")).toBeUndefined();
	});

	it("orders sessions by started_at DESC", async () => {
		const a = new HermesAdapter();
		const { sessions } = await a.collectSessions();
		// s-json started later than s-plain; s-empty is filtered out
		expect(sessions.map((s) => s.localSessionId)).toEqual(["s-json", "s-plain"]);
	});

	it("projectPath is null for every Hermes session (by design)", async () => {
		const a = new HermesAdapter();
		const { sessions } = await a.collectSessions();
		for (const s of sessions) expect(s.projectPath).toBeNull();
	});

	it("rawFilePath includes the session id anchor", async () => {
		const a = new HermesAdapter();
		const { sessions } = await a.collectSessions();
		expect(sessions[0]?.rawFilePath).toContain("state.db#");
	});
});

describe("HermesAdapter.collectSkills", () => {
	it("finds a nested skill at skills/core/demo/SKILL.md and skips SKIP_DIRS at every depth", async () => {
		const a = new HermesAdapter();
		const skills = await a.collectSkills();
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

	it("returns empty when skills dir is missing", async () => {
		// Point HOME at a fresh tmpdir with no .hermes/
		process.env.HOME = `/tmp/clawdi-empty-${Date.now()}`;
		const a = new HermesAdapter();
		expect(await a.collectSkills()).toEqual([]);
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
		await a.writeSkillArchive("demo", tarBytes);

		const extracted = join(tmpHome, ".hermes", "skills", "demo", "SKILL.md");
		expect(existsSync(extracted)).toBe(true);
		expect(readFileSync(extracted, "utf-8")).toContain("description: A nested demo skill");
	});

	it("getSkillPath returns the canonical SKILL.md anchor under skills/", () => {
		const a = new HermesAdapter();
		const p = a.getSkillPath("foo");
		expect(p).toBe(join(tmpHome, ".hermes", "skills", "foo", "SKILL.md"));
	});
});

describe("HermesAdapter.buildRunCommand", () => {
	it("prefixes arguments with the hermes binary", () => {
		const a = new HermesAdapter();
		expect(a.buildRunCommand(["hello", "world"], {})).toEqual(["hermes", "hello", "world"]);
	});
});
