import { describe, expect, test } from "bun:test";
import { partialUsageDescription, usagePageState } from "@/hosted/billing/usage/usage-page";

type Usage = Parameters<typeof usagePageState>[0];

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		period_start: "2026-07-01T00:00:00Z",
		period_end: "2026-08-01T00:00:00Z",
		availability: "complete",
		unavailable_sections: [],
		total_usd: "0",
		total_requests: 0,
		by_model: [],
		by_day: [],
		...overrides,
	};
}

describe("usage page availability", () => {
	test("renders unreadable usage as unavailable instead of no usage", () => {
		expect(
			usagePageState(
				usage({
					availability: "unavailable",
					unavailable_sections: ["totals", "by_model", "by_day"],
					total_usd: null,
					total_requests: null,
				}),
			),
		).toEqual({ kind: "unavailable" });
	});

	test("keeps a complete zero-usage account in the genuine empty state", () => {
		expect(usagePageState(usage())).toEqual({ kind: "empty" });
	});

	test("labels successful totals with a missing daily query as partial", () => {
		const state = usagePageState(
			usage({
				availability: "partial",
				unavailable_sections: ["by_day"],
				total_usd: "0.125",
				total_requests: 3,
				by_model: [{ model: "gpt-test", provider: null, amount_usd: "0.125", requests: 3 }],
			}),
		);

		expect(state.kind).toBe("partial");
		expect(state).toEqual({
			kind: "partial",
			description:
				"The daily breakdown is temporarily unavailable. The totals and model breakdown below are complete.",
		});
	});

	test("names totals and model breakdown when only daily data loaded", () => {
		expect(partialUsageDescription(["totals", "by_model"])).toContain(
			"Usage totals and the model breakdown",
		);
	});
});
