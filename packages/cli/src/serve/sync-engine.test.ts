import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ApiError } from "../lib/api-client";
import { isAuthFailure } from "./sync-engine";

describe("isAuthFailure", () => {
	// Pull-side and push-side both rely on this classifier to decide
	// whether to abort the daemon vs. log-and-retry. A wrong answer in
	// either direction is bad: missing a 401 means a revoked key
	// silently loops forever (the bug Codex flagged), and false-
	// positives on a transient 5xx would kill a healthy daemon.
	it.each([401, 403])("treats ApiError(%i) as auth failure", (status) => {
		const e = new ApiError({ status, body: "", hint: "" });
		expect(isAuthFailure(e)).toBe(true);
	});

	it.each([
		400, 404, 408, 429, 500, 502, 503,
	])("does not treat ApiError(%i) as auth failure", (status) => {
		const e = new ApiError({ status, body: "", hint: "" });
		expect(isAuthFailure(e)).toBe(false);
	});

	it("does not treat plain Error as auth failure", () => {
		expect(isAuthFailure(new Error("boom"))).toBe(false);
	});

	it("does not treat network errors (ApiError 0) as auth failure", () => {
		// Network errors normalise to status=0 in the api-client. They
		// must keep retrying — only an explicit 401/403 from the
		// server says the key is rejected.
		const e = new ApiError({ status: 0, body: "", hint: "", isNetwork: true });
		expect(isAuthFailure(e)).toBe(false);
	});

	it("does not treat null/undefined/strings as auth failure", () => {
		expect(isAuthFailure(null)).toBe(false);
		expect(isAuthFailure(undefined)).toBe(false);
		expect(isAuthFailure("401")).toBe(false);
		expect(isAuthFailure({ status: 401 })).toBe(false);
	});
});

describe("addInFlight / releaseInFlight refcount", () => {
	// Round-r5 P1: the watcher guard at sync-engine.ts:521 reads
	// `pullsInFlight.has(skillKey)` to short-circuit watcher
	// events fired while writeSkillArchive is rm+extracting (a
	// few-ms window where the dir is empty). Same Map is bumped
	// at the start of `writeSkillArchive` and released in a
	// `finally` — multiple concurrent pulls of the same skill
	// would otherwise have the second `releaseInFlight` clear
	// the entry while the first pull is still extracting,
	// re-opening the watcher echo window. Lock the contract.
	const { addInFlight, releaseInFlight } = require("./sync-engine") as {
		addInFlight: (m: Map<string, number>, k: string) => void;
		releaseInFlight: (m: Map<string, number>, k: string) => void;
	};

	it("has(key) is true between addInFlight and matching releaseInFlight", () => {
		const m = new Map<string, number>();
		addInFlight(m, "foo");
		expect(m.has("foo")).toBe(true);
		releaseInFlight(m, "foo");
		expect(m.has("foo")).toBe(false);
	});

	it("nested addInFlight: has() stays true until the LAST release", () => {
		const m = new Map<string, number>();
		addInFlight(m, "foo");
		addInFlight(m, "foo");
		expect(m.has("foo")).toBe(true);
		releaseInFlight(m, "foo");
		// First release: still in flight (count = 1).
		expect(m.has("foo")).toBe(true);
		releaseInFlight(m, "foo");
		expect(m.has("foo")).toBe(false);
	});

	it("releaseInFlight on missing key is a no-op (does not insert -1 entry)", () => {
		// Defense against an accidental `releaseInFlight` outside
		// a `finally` paired with addInFlight — must not leave a
		// negative-count entry that blocks future watcher events.
		const m = new Map<string, number>();
		releaseInFlight(m, "ghost");
		expect(m.has("ghost")).toBe(false);
	});

	it("entries are independent across keys", () => {
		const m = new Map<string, number>();
		addInFlight(m, "a");
		addInFlight(m, "b");
		expect(m.has("a")).toBe(true);
		expect(m.has("b")).toBe(true);
		releaseInFlight(m, "a");
		expect(m.has("a")).toBe(false);
		expect(m.has("b")).toBe(true);
	});
});

describe("resolveOwningSkillKey — dotfile-component skip", () => {
	// Reported in prod after the v0.5.0 daemon rollout: the codex
	// adapter watches `~/.codex/skills/` recursively. gstack ships
	// its own bundled sub-skills FOR OTHER AGENTS at paths like
	// `~/.codex/skills/gstack/.agents/skills/<sub>/SKILL.md`.
	// When the user (re)installs gstack, fs.watch fires for those
	// nested SKILL.md writes, the resolver greedily returned
	// `gstack/.agents/skills/<sub>` as the skill_key, daemon
	// enqueued a push, server's SKILL_KEY_PATTERN rejected with
	// 422 (every component must start with [A-Za-z0-9]), and the
	// log accumulated 700+ permanent drops. The correct behavior
	// is to keep walking up — the OUTERMOST non-dotfile ancestor
	// (here `gstack`) IS the real skill on the codex adapter.
	const { resolveOwningSkillKey } = require("./sync-engine") as {
		resolveOwningSkillKey: (root: string, pathFromRoot: string) => string | null;
	};

	const fs = require("node:fs");
	const path = require("node:path");
	const os = require("node:os");

	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-key-resolve-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	function makeSkillMd(...segments: string[]) {
		const dir = path.join(tmp, ...segments);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\n---\n");
	}

	it("returns the outer skill_key when a dotfile-nested SKILL.md exists", () => {
		// Mirrors gstack's bundled-sub-skills layout: top-level
		// `gstack/SKILL.md` is the real skill, `gstack/.agents/skills/<sub>/SKILL.md`
		// are bundled artifacts that aren't standalone codex skills.
		makeSkillMd("gstack");
		makeSkillMd("gstack", ".agents", "skills", "gstack-autoplan");

		// fs.watch fires on the deep nested file; resolver should
		// walk up past the dotfile branch and report `gstack`.
		expect(resolveOwningSkillKey(tmp, "gstack/.agents/skills/gstack-autoplan")).toBe("gstack");
	});

	it("returns null if every ancestor in the chain has a dotfile component", () => {
		// `gstack/.agents/skills/<sub>` exists but `gstack/SKILL.md`
		// does NOT — pathological case where the only skill candidate
		// fails the regex. Resolver returns null so daemon doesn't
		// enqueue anything.
		makeSkillMd("gstack", ".agents", "skills", "gstack-autoplan");
		expect(resolveOwningSkillKey(tmp, "gstack/.agents/skills/gstack-autoplan")).toBeNull();
	});

	it("returns the deepest valid skill_key for nested layouts (Hermes-style)", () => {
		// Hermes nests `category/foo/SKILL.md` without a `category/SKILL.md`.
		// Resolver should still pick the deepest match.
		makeSkillMd("category", "foo");
		expect(resolveOwningSkillKey(tmp, "category/foo")).toBe("category/foo");
		expect(resolveOwningSkillKey(tmp, "category/foo/references")).toBe("category/foo");
	});

	it("returns the top-level dir for flat layouts (Claude Code / Codex)", () => {
		makeSkillMd("autoplan");
		expect(resolveOwningSkillKey(tmp, "autoplan")).toBe("autoplan");
		expect(resolveOwningSkillKey(tmp, "autoplan/references/pattern.md")).toBe("autoplan");
	});

	it("returns null for a path with no SKILL.md ancestor", () => {
		expect(resolveOwningSkillKey(tmp, "no-skill-here")).toBeNull();
		expect(resolveOwningSkillKey(tmp, "deep/nested/no-skill")).toBeNull();
	});
});
