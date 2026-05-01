import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../lib/api-client";
import { isAuthFailure, isOversizedUploadError, resolveOwningSkillKey } from "./sync-engine";

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

describe("resolveOwningSkillKey — dotfile component rejection", () => {
	// Prod observed 728 `engine.queue_drop_permanent` 422 events
	// in the codex daemon log post-#66 deploy. gstack ships its
	// own bundled sub-skills FOR OTHER AGENTS at paths like
	// `~/.codex/skills/gstack/.agents/skills/<sub>/SKILL.md`.
	// fs.watch fires for those, the resolver greedily returned
	// the deepest SKILL.md match, and server's
	// SKILL_KEY_PATTERN rejected with 422 (every component must
	// start with [A-Za-z0-9]).
	//
	// The fix returns null on any path with a dotfile-prefixed
	// component. NOT walk-up to outer skill — that would convert
	// 422s into 413 cascades because the outer `gstack` folder
	// is the 1 GB monster that already trips the 25 MB upload
	// cap. The companion fix in lib/tar.ts excludes those
	// dotfile subtrees from the OUTER skill's tarball so it
	// stays under the cap.

	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "skill-key-resolve-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function makeSkillMd(...segments: string[]) {
		const dir = join(tmp, ...segments);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
	}

	it("returns null when ANY path component starts with a dot (gstack shape)", () => {
		makeSkillMd("gstack");
		makeSkillMd("gstack", ".agents", "skills", "gstack-autoplan");

		// fs.watch fires on the deep nested file; resolver MUST
		// NOT enqueue. Pre-fix this returned
		// `gstack/.agents/skills/gstack-autoplan` and 422'd.
		expect(resolveOwningSkillKey(tmp, "gstack/.agents/skills/gstack-autoplan")).toBeNull();
	});

	it("returns null even when the dotfile is at the leaf (.../foo/.cache/x)", () => {
		makeSkillMd("foo");
		mkdirSync(join(tmp, "foo", ".cache", "x"), { recursive: true });
		expect(resolveOwningSkillKey(tmp, "foo/.cache/x")).toBeNull();
	});

	it("returns the deepest valid skill_key for nested layouts (Hermes)", () => {
		// `category/foo/SKILL.md` exists but no dotfile in path.
		// Resolver returns the deepest match.
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

describe("resolveOwningSkillKey — Windows path separator", () => {
	// Codex flagged: on Windows, watcher.ts builds pathFromRoot
	// via path.join() → backslash-separated. A `/`-only split
	// missed dotfile components like `gstack\.agents\...`,
	// re-enabling the 422 spam this fix is meant to stop. The
	// resolver now splits on both `/` and `\`.
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "skill-key-resolve-win-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("rejects backslash-separated paths with dotfile components", () => {
		// Synthetic Windows-style input. Resolver doesn't actually
		// touch the filesystem for the dotfile check, so we don't
		// need a real backslash-named directory on macOS — the
		// rejection happens before any fs access.
		expect(resolveOwningSkillKey(tmp, "gstack\\.agents\\skills\\gstack-autoplan")).toBeNull();
	});

	it("rejects mixed-separator paths with dotfile components", () => {
		// Windows clients can produce mixed separators (e.g.
		// path.join joining a path that already had `/`).
		expect(resolveOwningSkillKey(tmp, "gstack/.agents\\skills/foo")).toBeNull();
	});
});

describe("isOversizedUploadError", () => {
	// The drain loop branches on this to demote oversize drops from
	// `error` to `warn` (no heartbeat poison). Misclassifying a 400
	// validation error as oversized would silently swallow real bugs.
	it("treats ApiError(413) as oversized", () => {
		expect(isOversizedUploadError(new ApiError({ status: 413, body: "", hint: "" }))).toBe(true);
	});

	it("treats pre-flight 'Skill tarball exceeds' as oversized", () => {
		expect(isOversizedUploadError(new Error("Skill tarball exceeds 26214400 bytes"))).toBe(true);
	});

	it("does not treat other 4xx as oversized", () => {
		for (const status of [400, 404, 422]) {
			expect(isOversizedUploadError(new ApiError({ status, body: "", hint: "" }))).toBe(false);
		}
	});

	it("does not treat unrelated Errors as oversized", () => {
		expect(isOversizedUploadError(new Error("symlink(s) pointing outside"))).toBe(false);
		expect(isOversizedUploadError(new Error("boom"))).toBe(false);
	});
});
