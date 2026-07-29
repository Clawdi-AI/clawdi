import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	buildWeeks,
	computeMonthLabels,
	parseCalendarDate,
} from "@/components/dashboard/contribution-graph";

const originalTimezone = process.env.TZ;

beforeAll(() => {
	process.env.TZ = "America/Los_Angeles";
});

afterAll(() => {
	if (originalTimezone === undefined) {
		delete process.env.TZ;
	} else {
		process.env.TZ = originalTimezone;
	}
});

describe("contribution calendar dates", () => {
	test("keeps a date-only value on its calendar day in a negative-offset timezone", () => {
		const date = parseCalendarDate("2026-07-01");

		expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/Los_Angeles");
		expect(date?.getFullYear()).toBe(2026);
		expect(date?.getMonth()).toBe(6);
		expect(date?.getDate()).toBe(1);
		expect(date?.getDay()).toBe(3);
	});

	test("aligns weeks and month labels from local calendar parts", () => {
		const weeks = buildWeeks([
			{ date: "2026-07-01", count: 1, level: 1 },
			{ date: "2026-07-02", count: 2, level: 2 },
		]);

		expect(weeks[0]?.findIndex((day) => day.date === "2026-07-01")).toBe(3);
		expect(computeMonthLabels(weeks)).toEqual(["Jul"]);
	});
});
