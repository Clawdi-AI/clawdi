"use client";

import {
	type AgentOverviewModuleContent,
	OverviewDescriptionSkeleton,
} from "@/components/dashboard/agent-overview-capabilities";
import { useAgentProjectVaults } from "@/components/vault/agent-vaults-query";

type SummaryState = {
	isLoading: boolean;
	isUnavailable?: boolean;
	error: unknown;
};

export function overviewProjectsModule({
	bindings,
}: {
	bindings: SummaryState & { count: number | null };
}): AgentOverviewModuleContent {
	if (bindings.isLoading) return { description: <OverviewDescriptionSkeleton label="projects" /> };
	if (bindings.isUnavailable) return { description: "Unavailable right now" };
	if (bindings.error) return { description: "Unavailable right now" };
	const count = bindings.count ?? 0;
	const primary = count ? `${count} ${count === 1 ? "project" : "projects"}` : "No projects added";
	return { description: primary };
}

export function overviewSkillsModule({
	items,
	...state
}: SummaryState & { items: readonly string[] }): AgentOverviewModuleContent {
	if (state.isLoading) return { description: <OverviewDescriptionSkeleton label="skills" /> };
	if (state.isUnavailable) return { description: "Unavailable right now" };
	if (state.error) return { description: "Unavailable right now" };
	return {
		description: items.length
			? `${items.length} ${items.length === 1 ? "skill" : "skills"}`
			: "No skills available",
	};
}

export function useOverviewVaultsModule({
	projectIds,
	resolution,
	enabled = true,
}: {
	projectIds: readonly string[];
	resolution: "loading" | "unavailable" | "ready";
	enabled?: boolean;
}): AgentOverviewModuleContent {
	const query = useAgentProjectVaults(projectIds, { enabled: enabled && resolution === "ready" });
	if (resolution === "loading" || query.isLoading)
		return { description: <OverviewDescriptionSkeleton label="vaults" /> };
	if (resolution === "unavailable") return { description: "Unavailable right now" };
	if (query.error) return { description: "Unavailable right now" };
	const vaults = query.data ?? [];
	return {
		description: vaults.length
			? `${vaults.length} ${vaults.length === 1 ? "vault" : "vaults"}`
			: "No vaults available",
	};
}
