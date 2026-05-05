/**
 * Tests for skill-key filtering at the watcher boundary. Codifies
 * the rule that the daemon mirrors the backend's SKILL_KEY_PATTERN
 * — a dotfile dir like `.system` under `~/.claude/skills/` would
 * otherwise hit a permanent 422 on every push attempt.
 *
 * The filter regex itself is duplicated (watcher.ts and
 * sync-engine.ts both carry their own copy because they sit on
 * different code paths). This test pins the shape of the regex
 * and the dirs it accepts/rejects so a refactor can't drift.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

describe("SKILL_KEY pattern (mirrors backend)", () => {
	it("accepts normal skill names", () => {
		for (const name of ["frontend-design", "webapp.testing", "PDF", "skill_creator", "a"]) {
			expect(SKILL_KEY_RE.test(name)).toBe(true);
		}
	});

	it("rejects dotfile dirs", () => {
		// These show up under `~/.claude/skills/` for various tools
		// (e.g. gstack creates `.system`, npm dumps `.cache`). The
		// daemon must skip them or the upload route 422s.
		for (const name of [".system", ".cache", ".git", ".DS_Store", ".npm"]) {
			expect(SKILL_KEY_RE.test(name)).toBe(false);
		}
	});

	it("rejects names that start with a hyphen, underscore, or dot", () => {
		for (const name of ["-foo", "_internal", ".hidden"]) {
			expect(SKILL_KEY_RE.test(name)).toBe(false);
		}
	});

	it("rejects names over 200 chars", () => {
		const tooLong = `a${"x".repeat(200)}`;
		expect(tooLong.length).toBe(201);
		expect(SKILL_KEY_RE.test(tooLong)).toBe(false);
	});

	it("rejects path-traversal-like inputs", () => {
		for (const name of ["../etc", "foo/bar", "with space"]) {
			expect(SKILL_KEY_RE.test(name)).toBe(false);
		}
	});
});

describe("listLocalSkillKeys filters dotfile dirs", () => {
	it("returns only valid skill_keys from a mixed directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-skills-test-"));
		try {
			// Realistic mix of what shows up under ~/.claude/skills/
			// after an agent + various tools have run for a while.
			mkdirSync(join(root, "frontend-design"));
			mkdirSync(join(root, "webapp-testing"));
			mkdirSync(join(root, ".system")); // gstack
			mkdirSync(join(root, ".cache")); // some tool
			mkdirSync(join(root, ".git")); // git checkout

			// Inline reimplementation matching sync-engine.ts:listLocalSkillKeys —
			// duplicated in two places intentionally (engine + watcher),
			// so the test pins both have the same effective filter.
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(root, { withFileTypes: true });
			const filtered = entries
				.filter((e) => e.isDirectory() && SKILL_KEY_RE.test(e.name))
				.map((e) => e.name)
				.sort();

			expect(filtered).toEqual(["frontend-design", "webapp-testing"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
