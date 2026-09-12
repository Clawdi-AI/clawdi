import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebouncedSkillChangeEmitter, watchSkills } from "./watcher";

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
						onSkillChanged: (key) => {
							changed.push(key);
						},
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
