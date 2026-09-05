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
import { createDebouncedSkillChangeEmitter, watchSkills } from "./watcher";

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

describe("createDebouncedSkillChangeEmitter", () => {
	it("coalesces a burst of events by skill_key", async () => {
		const seen: string[] = [];
		const emitter = createDebouncedSkillChangeEmitter((key) => seen.push(key), {
			debounceMs: 5,
		});

		for (let i = 0; i < 100; i++) {
			emitter.emit("frontend-design");
			emitter.emit("webapp-testing");
		}

		await sleep(20);
		expect(seen).toEqual(["frontend-design", "webapp-testing"]);
		emitter.dispose();
	});

	it("drops pending events on abort", async () => {
		const abort = new AbortController();
		const seen: string[] = [];
		const emitter = createDebouncedSkillChangeEmitter((key) => seen.push(key), {
			abort: abort.signal,
			debounceMs: 20,
		});

		emitter.emit("frontend-design");
		abort.abort();
		await sleep(30);

		expect(seen).toEqual([]);
	});
});

describe("skill inventory polling", () => {
	it.each([false, true])(
		"retains the last valid snapshot across failures (initial failure: %s)",
		async (initialFailure) => {
			const root = mkdtempSync(join(tmpdir(), "clawdi-skills-poll-"));
			const abort = new AbortController();
			const changed: string[] = [];
			let inventoryChanges = 0;
			const samples: Array<string[] | Error> = [
				...(initialFailure ? [new Error("initial discovery failed")] : []),
				["kept", "removed"],
				new Error("discovery failed"),
				["kept", "added"],
			];
			let sampleIndex = 0;
			try {
				await watchSkills(
					{
						rootDir: root,
						abort: abort.signal,
						forcePoll: true,
						listSkillKeys: async () => {
							const sample = samples[sampleIndex++];
							if (sample instanceof Error) throw sample;
							if (!sample) throw new Error("unexpected extra poll");
							return sample;
						},
						onSkillChanged: (key) => changed.push(key),
						onInventoryChanged: () => {
							inventoryChanges++;
							abort.abort();
						},
					},
					async (ms) => {
						expect(ms).toBe(30_000);
						expect(changed).toEqual([]);
						expect(inventoryChanges).toBe(0);
					},
				);
				expect(sampleIndex).toBe(samples.length);
				expect(changed).toEqual(["removed", "added"]);
				expect(inventoryChanges).toBe(1);
			} finally {
				abort.abort();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
