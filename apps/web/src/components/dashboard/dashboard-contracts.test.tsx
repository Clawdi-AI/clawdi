import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentGreetingSummary } from "@/components/dashboard/greeting";
import { ThisWeekCard } from "@/components/dashboard/this-week-card";
import type { DashboardStats } from "@/lib/api-schemas";
import { getProjectResourceDefinition, projectResourceCount } from "@/lib/project-resource-model";

function stats(overrides: Partial<DashboardStats> = {}): DashboardStats {
	return {
		total_sessions: 40,
		total_messages: 100,
		total_tokens: 1_000,
		active_days: 8,
		current_streak: 2,
		longest_streak: 5,
		peak_hour: 10,
		favorite_model: "all-time-model",
		projects_count: 3,
		skills_count: 4,
		memories_count: 6,
		vault_count: 2,
		vault_keys_count: 99,
		connectors_count: 3,
		manual_sessions_last_7_days: 7,
		automated_sessions_last_7_days: 11,
		top_model_last_7_days: "weekly-model",
		sessions_today: 5,
		contribution: [],
		...overrides,
	};
}

describe("dashboard data contracts", () => {
	test("uses the visible Vault inventory count rather than its number of keys", () => {
		expect(projectResourceCount(getProjectResourceDefinition("vaults"), stats(), 1)).toBe(2);
	});

	test("renders direct seven-day fields without deriving them from contribution data", () => {
		const markup = renderToStaticMarkup(createElement(ThisWeekCard, { stats: stats() }));

		expect(markup).toContain("Last 7 days");
		expect(markup).toContain("weekly-model");
		expect(markup).not.toContain("all-time-model");
		expect(markup).toContain("+ 11 automated");
		expect(markup).toContain(">7<");
		expect(markup).toContain(">5<");
	});

	test("does not show first-agent empty copy while membership is unresolved", () => {
		expect(agentGreetingSummary(0, "loading")).toBe("Loading agent status…");
		expect(agentGreetingSummary(0, "resolved")).toBe(
			"Get your first agent running to start syncing.",
		);
		expect(agentGreetingSummary(0, "error")).toBe("Agent status is unavailable right now.");
	});
});
