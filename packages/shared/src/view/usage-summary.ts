import type { DeployComponents } from "../api";
import { agentIdentity } from "./agent-label";
import type { AgentTile } from "./agent-tiles";
import { addDecimals, compareDecimals } from "./billing-format";

export type HostedUsageSummary = DeployComponents["schemas"]["V2HostedUsageSummaryResponse"];
export type UsageAgentBreakdown = NonNullable<HostedUsageSummary["by_agent"]>[number];
export type UsageModelBreakdown = HostedUsageSummary["by_model"][number];
export type UsageDayBreakdown = HostedUsageSummary["by_day"][number];
export type VisibleUsageSection = "totals" | "by_model" | "by_day";
export type UsageRangeDays = 7 | 30 | 90;

export type UsageAgentIdentity = {
	name: string | null;
	displayName: string | null;
	defaultName: string | null;
	machineName: string | null;
	type: string | null;
};
export type UsageAgentOption = {
	id: string;
	identity: UsageAgentIdentity;
	deleted: boolean;
};

/** Web settings AI Usage panel copy. */
export const usageCopy = {
	nav: "AI Usage",
	navSummary: "LLM spend in USD, paid from wallet",
	title: "Usage",
	agent: "Agent",
	allAgents: "All agents",
	deleted: "Deleted",
	timeRange: "Time range",
	summary: "Usage summary",
	spend: "Spend",
	requests: "Requests",
	spendOverTime: "Spend over time",
	models: "Models",
	model: "Model",
	usageByModel: "Usage by model",
	usageUnavailable: "Usage unavailable",
	totalsUnavailable: "Totals unavailable",
	trendUnavailable: "Trend unavailable",
	modelsUnavailable: "Models unavailable",
	noUsage: "No usage",
	retry: "Retry",
	peak: "Peak",
	modelsTruncated: "Showing the {limit} highest-spend models.",
} as const;

export const USAGE_RANGE_ITEMS = [
	{ label: "Last 7 days", value: "7" },
	{ label: "Last 30 days", value: "30" },
	{ label: "Last 90 days", value: "90" },
] as const;

function compareStableText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

/** Highest spend first, then model name and provider for a stable order. */
export function sortModelBreakdown(left: UsageModelBreakdown, right: UsageModelBreakdown): number {
	const spendOrder = -(compareDecimals(left.amount_usd, right.amount_usd) ?? 0);
	if (spendOrder !== 0) return spendOrder;
	const modelOrder = compareStableText(left.model.toLowerCase(), right.model.toLowerCase());
	return modelOrder !== 0
		? modelOrder
		: compareStableText(left.provider ?? "", right.provider ?? "");
}

function usageAgentIdentity(agent: UsageAgentBreakdown): UsageAgentIdentity {
	return {
		name: agent.agent_name ?? null,
		displayName: null,
		defaultName: null,
		machineName: null,
		type: agent.agent_type ?? null,
	};
}

function usageAgentTileIdentity(tile: AgentTile): UsageAgentIdentity {
	return {
		name: tile.env?.name ?? tile.name,
		displayName: tile.env?.display_name ?? null,
		defaultName: tile.env?.default_name ?? null,
		machineName: tile.env?.machine_name ?? null,
		type: tile.env?.agent_type ?? tile.agentType,
	};
}

export function usageAgentText(identity: UsageAgentIdentity): string {
	return agentIdentity({
		name: identity.name,
		display_name: identity.displayName,
		default_name: identity.defaultName,
		machine_name: identity.machineName,
		agent_type: identity.type,
	}).primaryLabel;
}

/** Current Cloud Agents plus Agents that only appear in usage history (possibly deleted). */
export function usageAgentOptions(
	agents: readonly UsageAgentBreakdown[],
	agentTiles: readonly AgentTile[],
): UsageAgentOption[] {
	const options = new Map<string, UsageAgentOption>();
	for (const tile of agentTiles) {
		if (tile.source !== "on-clawdi") continue;
		options.set(tile.id, {
			id: tile.id,
			identity: usageAgentTileIdentity(tile),
			deleted: false,
		});
	}

	for (const agent of agents) {
		if (!agent.agent_id || options.has(agent.agent_id)) continue;
		options.set(agent.agent_id, {
			id: agent.agent_id,
			identity: usageAgentIdentity(agent),
			deleted: agent.agent_deleted === true,
		});
	}

	return [...options.values()].sort((left, right) => {
		const labelOrder = compareStableText(
			usageAgentText(left.identity).toLowerCase(),
			usageAgentText(right.identity).toLowerCase(),
		);
		return labelOrder !== 0 ? labelOrder : compareStableText(left.id, right.id);
	});
}

export function formatUsageDate(value: string): string {
	const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(date.valueOf())) return "—";
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
}

export function usageWindowLabel(usage: Pick<HostedUsageSummary, "period_start" | "period_end">) {
	return `${formatUsageDate(usage.period_start)} – ${formatUsageDate(usage.period_end)} · UTC`;
}

/** Highest single-day spend and the window total, as exact decimal USD strings. */
export function dailyUsageTotals(days: readonly UsageDayBreakdown[]): {
	peak: string;
	total: string;
} {
	return {
		peak: days.reduce(
			(maximum, day) => (compareDecimals(day.amount_usd, maximum) === 1 ? day.amount_usd : maximum),
			"0",
		),
		total: days.reduce((total, day) => addDecimals(total, day.amount_usd) ?? total, "0"),
	};
}

/** Accessible summary of the daily chart; `total` is already formatted for display. */
export function dailySpendLabel(days: readonly UsageDayBreakdown[], total: string): string {
	const first = days[0];
	const last = days.at(-1);
	return `Daily spend from ${first ? formatUsageDate(first.date) : "the start of the window"} to ${last ? formatUsageDate(last.date) : "the end of the window"}: ${total} total.`;
}

export function unavailableUsageSections(usage: HostedUsageSummary): Set<VisibleUsageSection> {
	const sections = new Set<VisibleUsageSection>();
	if (
		usage.unavailable_sections.includes("totals") ||
		usage.total_usd === null ||
		usage.total_requests === null
	) {
		sections.add("totals");
	}
	if (usage.unavailable_sections.includes("by_model")) sections.add("by_model");
	if (usage.unavailable_sections.includes("by_day") || !Array.isArray(usage.by_day)) {
		sections.add("by_day");
	}
	return sections;
}

/** The single section that offers Retry when only some sections are unavailable. */
export function usageRetrySection(
	missing: ReadonlySet<VisibleUsageSection>,
): VisibleUsageSection | null {
	if (missing.has("totals")) return "totals";
	if (missing.has("by_day")) return "by_day";
	if (missing.has("by_model")) return "by_model";
	return null;
}

/** Fills missing UTC days in the window with zero spend, capped at one year. */
export function completeDailyBreakdown(
	days: readonly UsageDayBreakdown[],
	periodStart: string,
	periodEnd: string,
): UsageDayBreakdown[] {
	const start = new Date(`${periodStart.slice(0, 10)}T00:00:00Z`);
	const end = new Date(`${periodEnd.slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) {
		return [...days].sort((left, right) => compareStableText(left.date, right.date));
	}

	const amountByDate = new Map(days.map((day) => [day.date, day.amount_usd]));
	const completed: UsageDayBreakdown[] = [];
	for (let cursor = start, count = 0; cursor <= end && count < 366; count += 1) {
		const date = cursor.toISOString().slice(0, 10);
		completed.push({ date, amount_usd: amountByDate.get(date) ?? "0" });
		cursor = new Date(cursor.valueOf() + 86_400_000);
	}
	return completed;
}

export function usageRangeDays(value: string | null): UsageRangeDays {
	switch (value) {
		case "30":
			return 30;
		case "90":
			return 90;
		default:
			return 7;
	}
}
