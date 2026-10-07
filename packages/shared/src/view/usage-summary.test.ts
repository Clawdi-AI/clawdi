import { describe, expect, test } from "bun:test";
import type { AgentTile } from "./agent-tiles";
import {
	completeDailyBreakdown,
	type HostedUsageSummary,
	sortModelBreakdown,
	unavailableUsageSections,
	usageAgentOptions,
	usageRetrySection,
} from "./usage-summary";

const usage: HostedUsageSummary = {
	period_start: "2026-10-01T00:00:00Z",
	period_end: "2026-10-03T00:00:00Z",
	availability: "complete",
	unavailable_sections: [],
	breakdown_limit: 100,
	total_usd: "1.50",
	total_requests: 3,
	by_model: [],
	by_day: [],
};

describe("usage summary view", () => {
	test("fills every UTC day of the window", () => {
		expect(
			completeDailyBreakdown(
				[{ date: "2026-10-02", amount_usd: "1.50" }],
				usage.period_start,
				usage.period_end,
			),
		).toEqual([
			{ date: "2026-10-01", amount_usd: "0" },
			{ date: "2026-10-02", amount_usd: "1.50" },
			{ date: "2026-10-03", amount_usd: "0" },
		]);
		expect(
			completeDailyBreakdown(
				[
					{ date: "2026-10-02", amount_usd: "1" },
					{ date: "2026-10-01", amount_usd: "2" },
				],
				"invalid",
				usage.period_end,
			).map((day) => day.date),
		).toEqual(["2026-10-01", "2026-10-02"]);
	});

	test("treats null totals as unavailable and retries the first missing section", () => {
		const missing = unavailableUsageSections({
			...usage,
			total_usd: null,
			unavailable_sections: ["by_model"],
		});
		expect([...missing].sort()).toEqual(["by_model", "totals"]);
		expect(usageRetrySection(missing)).toBe("totals");
		expect(usageRetrySection(new Set(["by_model", "by_day"]))).toBe("by_day");
		expect(usageRetrySection(new Set())).toBeNull();
	});

	test("orders models by spend, then name and provider", () => {
		const models = [
			{ model: "b", provider: null, amount_usd: "1", requests: 1 },
			{ model: "a", provider: "z", amount_usd: "1", requests: 1 },
			{ model: "a", provider: "y", amount_usd: "1", requests: 1 },
			{ model: "c", provider: null, amount_usd: "2.5", requests: 1 },
		];
		expect(
			[...models].sort(sortModelBreakdown).map((item) => `${item.model}:${item.provider}`),
		).toEqual(["c:null", "a:y", "a:z", "b:null"]);
	});

	test("merges current Cloud Agents with deleted Agents from usage history", () => {
		const tiles: AgentTile[] = [
			{ id: "a2", source: "on-clawdi", name: "Zed", agentType: "openclaw", href: null },
			{ id: "local", source: "self-managed", name: "Laptop", agentType: null, href: null },
		];
		const options = usageAgentOptions(
			[
				{ agent_id: "a2", agent_name: "Old", amount_usd: "1", requests: 1 },
				{ agent_id: "a1", agent_name: "Alpha", agent_deleted: true, amount_usd: "1", requests: 1 },
				{ agent_id: null, agent_name: "Unknown", amount_usd: "1", requests: 1 },
			],
			tiles,
		);
		expect(options.map((option) => [option.id, option.deleted])).toEqual([
			["a1", true],
			["a2", false],
		]);
	});
});
