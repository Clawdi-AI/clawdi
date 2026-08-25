import { describe, expect, test } from "bun:test";
import { daemonStatusVisual } from "@/components/dashboard/daemon-status";

function evidence(ageMs: number) {
	return {
		sync_enabled: true,
		last_sync_at: new Date(Date.now() - ageMs).toISOString(),
		last_sync_error: null,
	};
}

describe("daemon runtime observation freshness", () => {
	test("keeps a heartbeat live across two expected reporting intervals", () => {
		expect(daemonStatusVisual(evidence(120_000)).kind).toBe("live");
	});

	test("marks a heartbeat stale after the 150 second evidence window", () => {
		expect(daemonStatusVisual(evidence(151_000)).kind).toBe("paused");
	});
});
