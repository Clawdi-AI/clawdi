import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawSession } from "../adapters/base";
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

function session(realUserInputAt: string | null): RawSession {
	return {
		localSessionId: "session-1",
		projectPath: null,
		startedAt: new Date("2026-08-01T00:00:00Z"),
		endedAt: null,
		messageCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		model: null,
		modelsUsed: [],
		durationSeconds: null,
		summary: null,
		messages: [],
		rawFilePath: "/fixture",
		realUserInputAt,
	};
}

describe("runtime user activity state", () => {
	test("builds one complete baseline and refreshes it from watcher deltas", () => {
		const path = statePath();
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			sessions: [session("2026-08-01T00:00:00Z")],
			complete: true,
			activityComplete: true,
			observedAt: new Date("2026-08-02T00:00:00Z"),
		});
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			sessions: [],
			complete: false,
			activityComplete: true,
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
			sessions: [session(null)],
			complete: true,
			activityComplete: true,
			observedAt: new Date("2026-08-02T00:00:00Z"),
		});
		markRuntimeUserActivityUnknown("openclaw", "fixture_failure");
		recordRuntimeUserActivityScan({
			agentType: "openclaw",
			sessions: [],
			complete: false,
			activityComplete: true,
			observedAt: new Date("2026-08-03T00:00:00Z"),
		});

		expect(readRuntimeUserActivityState(path)?.classification).toBe("unknown");
	});
});
