import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	markRuntimeUserActivityUnknown,
	readRuntimeUserActivityState,
	recordRuntimeUserActivityScan,
	runtimeUserActivityStatePath,
} from "./user-activity-state";

const roots: string[] = [];
const originalStateDir = process.env.CLAWDI_STATE_DIR;

afterEach(() => {
	if (originalStateDir === undefined) delete process.env.CLAWDI_STATE_DIR;
	else process.env.CLAWDI_STATE_DIR = originalStateDir;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function statePath(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-user-activity-"));
	roots.push(root);
	process.env.CLAWDI_STATE_DIR = root;
	return runtimeUserActivityStatePath("openclaw");
}

describe("runtime user activity state", () => {
	test("rebuilds a Hermes baseline when the cached timestamp predates the tool exclusion", () => {
		statePath();
		const path = runtimeUserActivityStatePath("hermes");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeUserActivity.v1",
				agentType: "hermes",
				classifierVersion: 1,
				classification: "known_last_user_input",
				lastUserInputAt: "2026-08-01T00:00:00Z",
				completeAt: "2026-08-02T00:00:00Z",
				observedAt: "2026-08-02T00:00:00Z",
			}),
		);
		recordRuntimeUserActivityScan({
			agentType: "hermes",
			userActivity: { lastUserInputAt: null, recentUserInputCount: 0, complete: true },
			complete: true,
			observedAt: new Date("2026-08-03T00:00:00Z"),
		});
		expect(readRuntimeUserActivityState(path)).toMatchObject({
			classifierVersion: 2,
			classification: "known_no_user_input",
			lastUserInputAt: null,
			recentUserInputCount: 0,
		});
	});

	test("keeps the count tied to its scan window and drops it on a newer delta", () => {
		const path = statePath();
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: {
				lastUserInputAt: "2026-08-01T00:00:00Z",
				recentUserInputCount: 1,
				complete: true,
			},
			complete: true,
			observedAt: new Date("2026-08-02T00:00:00Z"),
		});
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: null, recentUserInputCount: null, complete: true },
			complete: false,
			observedAt: new Date("2026-08-03T00:00:00Z"),
		});

		expect(readRuntimeUserActivityState(path)).toMatchObject({
			classification: "known_last_user_input",
			lastUserInputAt: "2026-08-01T00:00:00.000Z",
			recentUserInputCount: 1,
			observedAt: "2026-08-02T00:00:00.000Z",
			completeAt: "2026-08-02T00:00:00.000Z",
		});

		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: {
				lastUserInputAt: "2026-08-03T00:00:00Z",
				recentUserInputCount: null,
				complete: true,
			},
			complete: false,
			observedAt: new Date("2026-08-03T00:01:00Z"),
		});
		expect(readRuntimeUserActivityState(path)).toMatchObject({
			lastUserInputAt: "2026-08-03T00:00:00.000Z",
			recentUserInputCount: null,
			observedAt: "2026-08-03T00:01:00.000Z",
		});
	});

	test.each(["partial", "timeout"] as const)(
		"preserves the baseline after a %s count refresh",
		(failure) => {
			const path = statePath();
			const observedAt = new Date("2026-08-02T00:00:00Z");
			recordRuntimeUserActivityScan({
				agentType: "openclaw",
				userActivity: {
					lastUserInputAt: "2026-08-01T00:00:00.000Z",
					recentUserInputCount: 3,
					complete: true,
				},
				complete: true,
				observedAt,
			});
			const baseline = readRuntimeUserActivityState(path);
			if (!baseline) throw new Error("expected an activity baseline");
			if (failure === "timeout") {
				markRuntimeUserActivityUnknown("openclaw", "fixture_timeout", true);
			} else {
				recordRuntimeUserActivityScan({
					agentType: "openclaw",
					userActivity: { lastUserInputAt: null, recentUserInputCount: null, complete: false },
					complete: true,
					refresh: true,
					materialize: true,
					observedAt: new Date("2026-08-02T00:05:00Z"),
				});
			}
			expect(readRuntimeUserActivityState(path)).toEqual({
				...baseline,
				recentUserInputCount: null,
			});
		},
	);

	test("requires another complete scan after a failed baseline scan", () => {
		const path = statePath();
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: null, recentUserInputCount: 0, complete: true },
			complete: true,
			observedAt: new Date("2026-08-02T00:00:00Z"),
		});
		markRuntimeUserActivityUnknown("openclaw", "fixture_failure");
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: null, recentUserInputCount: null, complete: true },
			complete: false,
			observedAt: new Date(Date.now() + 1000),
		});

		expect(readRuntimeUserActivityState(path)?.classification).toBe("unknown");
	});

	test("converges after an incomplete scan without losing a trustworthy timestamp", () => {
		const path = statePath();
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: {
				lastUserInputAt: "2026-08-01T00:00:00Z",
				recentUserInputCount: null,
				complete: false,
			},
			complete: true,
			observedAt: new Date("2026-08-02T00:00:00Z"),
		});
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: null, recentUserInputCount: 0, complete: true },
			complete: true,
			observedAt: new Date("2026-08-03T00:00:00Z"),
		});

		expect(readRuntimeUserActivityState(path)).toMatchObject({
			agentType: "openclaw",
			classification: "known_last_user_input",
			lastUserInputAt: "2026-08-01T00:00:00.000Z",
			recentUserInputCount: null,
			completeAt: "2026-08-03T00:00:00.000Z",
		});
	});
});
