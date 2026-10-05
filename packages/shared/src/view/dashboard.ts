import type { DashboardStats } from "../api";
import { formatModelLabel } from "./format";
import { getProjectResourceDefinition, projectResourceCount } from "./project-resource-model";

export function thisWeekModel(stats: DashboardStats | undefined) {
	const ready = !!stats;
	const todaySessions = stats?.sessions_today;
	const topModel = formatModelLabel(stats?.top_model_last_7_days) || null;
	const manualWeek = stats?.manual_sessions_last_7_days;
	const automatedWeek = stats?.automated_sessions_last_7_days;

	const streakLabel = ready ? `${stats.current_streak}d` : null;
	return { ready, todaySessions, topModel, manualWeek, automatedWeek, streakLabel };
}

export const LIBRARY_ROW_IDS = ["projects", "skills", "vaults", "connectors"] as const;

export function dashboardResources(stats: DashboardStats) {
	return LIBRARY_ROW_IDS.map((id) => {
		const definition = getProjectResourceDefinition(id);
		return { definition, count: projectResourceCount(definition, stats, stats.projects_count) };
	});
}

export const DASHBOARD_COPY = {
	weeklyTitle: "Last 7 days",
	weeklyDescription: "Agent activity, measured in UTC.",
	weeklyError: "Couldn't load weekly activity",
	yourSessions: "Your sessions",
	today: "Today",
	streak: "Streak",
	topModel: "Top model",
	libraryTitle: "Library",
	libraryError: "Couldn't load resources",
	noActivity: "No activity data yet.",
} as const;
