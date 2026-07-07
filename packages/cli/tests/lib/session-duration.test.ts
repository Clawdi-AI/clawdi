import { describe, expect, it } from "bun:test";
import { durationSecondsBetween } from "../../src/lib/session-duration";

describe("durationSecondsBetween", () => {
	it("computes whole seconds for normal sessions", () => {
		expect(
			durationSecondsBetween(
				new Date("2026-01-01T12:00:00.000Z"),
				new Date("2026-01-01T12:00:05.900Z"),
			),
		).toBe(5);
	});

	it("returns null when endedAt is missing", () => {
		expect(durationSecondsBetween(new Date("2026-01-01T12:00:00.000Z"), null)).toBeNull();
	});

	it("clamps clock-skewed negative durations to zero", () => {
		expect(
			durationSecondsBetween(
				new Date("2026-01-01T12:00:05.000Z"),
				new Date("2026-01-01T12:00:00.000Z"),
			),
		).toBe(0);
	});
});
