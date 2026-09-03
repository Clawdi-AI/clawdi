import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	test("builds one complete baseline and refreshes it from watcher deltas", () => {
		const path = statePath();
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: "2026-08-01T00:00:00Z", complete: true },
			complete: true,
			observedAt: new Date("2026-08-02T00:00:00Z"),
		});
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: null, complete: true },
			complete: false,
			observedAt: new Date("2026-08-03T00:00:00Z"),
		});

		expect(readRuntimeUserActivityState(path)).toMatchObject({
			classification: "known_last_user_input",
			lastUserInputAt: "2026-08-01T00:00:00.000Z",
			observedAt: "2026-08-03T00:00:00.000Z",
			completeAt: "2026-08-03T00:00:00.000Z",
		});
	});

	test("requires another complete scan after any failed scan", () => {
		const path = statePath();
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: null, complete: true },
			complete: true,
			observedAt: new Date("2026-08-02T00:00:00Z"),
		});
		markRuntimeUserActivityUnknown("openclaw", "fixture_failure");
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: null, complete: true },
			complete: false,
			observedAt: new Date("2026-08-03T00:00:00Z"),
		});

		expect(readRuntimeUserActivityState(path)?.classification).toBe("unknown");
	});

	test("converges after an incomplete scan without losing a trustworthy timestamp", () => {
		const path = statePath();
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: "2026-08-01T00:00:00Z", complete: false },
			complete: true,
			observedAt: new Date("2026-08-02T00:00:00Z"),
		});
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			userActivity: { lastUserInputAt: null, complete: true },
			complete: true,
			observedAt: new Date("2026-08-03T00:00:00Z"),
		});

		expect(readRuntimeUserActivityState(path)).toMatchObject({
			agentType: "openclaw",
			classification: "known_last_user_input",
			lastUserInputAt: "2026-08-01T00:00:00.000Z",
			completeAt: "2026-08-03T00:00:00.000Z",
		});
	});
});
