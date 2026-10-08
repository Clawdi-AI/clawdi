"use client";
import { agentOverviewSummary } from "@clawdi/shared/view";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	type AgentOverviewModuleContent,
	OverviewDescriptionSkeleton,
} from "@/components/dashboard/agent-overview-capabilities";
import { fetchAgentProjectSkills } from "@/components/dashboard/agent-skill-inventory";
import { useAgentProjectVaults } from "@/components/vault/agent-vaults-query";
import { unwrap, useApi } from "@/lib/api";
import { isActiveConnection, useConnections } from "@/lib/connectors-data";
import { shouldBlockQueryError } from "@/lib/query-state";

type SummaryState = {
	isLoading: boolean;
	isUnavailable?: boolean;
	error: unknown;
};

export function overviewWorkspaceSkillsModule(
	skillKeys: readonly string[],
): AgentOverviewModuleContent {
	const total = new Set(skillKeys).size;
	return {
		description: agentOverviewSummary("skills", total),
	};
}

export function overviewProjectsModule({
	bindings,
}: {
	bindings: SummaryState & { count: number | null };
}): AgentOverviewModuleContent {
	if (bindings.isLoading) return { description: <OverviewDescriptionSkeleton label="projects" /> };
	if (bindings.isUnavailable) return { description: "Unavailable right now" };
	if (shouldBlockQueryError(bindings.error, bindings.count))
		return { description: "Unavailable right now" };
	const count = bindings.count ?? 0;
	const primary = agentOverviewSummary("projects", count);
	return { description: primary };
}

export function useOverviewWorkspaceSkillsModule({
	projectId,
	resolution,
	skillKeys = [],
	enabled = true,
}: {
	projectId: string | null;
	resolution: "loading" | "unavailable" | "ready";
	skillKeys?: readonly string[];
	enabled?: boolean;
}): AgentOverviewModuleContent {
	const api = useApi();
	const query = useQuery({
		queryKey: ["skills", "workspace-overview", projectId],
		queryFn: async () => {
			if (!projectId) throw new Error("Workspace is unavailable");
			return fetchAgentProjectSkills(
				[projectId],
				async (currentProjectId, page, pageSize) =>
					unwrap(
						await api.GET("/v1/skills", {
							params: {
								query: { project_id: currentProjectId, page, page_size: pageSize },
							},
						}),
					),
				{ pageSize: 200 },
			);
		},
		enabled: enabled && resolution === "ready" && Boolean(projectId),
	});
	if (resolution === "loading" || query.isLoading)
		return { description: <OverviewDescriptionSkeleton label="skills" /> };
	if (resolution === "unavailable" || shouldBlockQueryError(query.error, query.data))
		return { description: "Unavailable right now" };
	return overviewWorkspaceSkillsModule([
		...skillKeys,
		...(query.data ?? []).map((skill) => skill.skill_key),
	]);
}

export function useOverviewMemoriesModule({
	enabled = true,
	staticWhileLoading = false,
}: {
	enabled?: boolean;
	/** Show the empty summary instead of a skeleton until the count arrives. */
	staticWhileLoading?: boolean;
} = {}): AgentOverviewModuleContent {
	const api = useApi();
	const query = useQuery({
		queryKey: ["memories", "", "", 0, 1],
		queryFn: async () =>
			unwrap(await api.GET("/v1/memories", { params: { query: { page: 1, page_size: 1 } } })),
		enabled,
	});
	if (staticWhileLoading && !query.data)
		return { description: agentOverviewSummary("memories", 0) };
	if (query.isLoading) return { description: <OverviewDescriptionSkeleton label="memories" /> };
	if (shouldBlockQueryError(query.error, query.data))
		return { description: "Unavailable right now" };
	const total = query.data?.total ?? 0;
	return {
		description: agentOverviewSummary("memories", total),
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
	if (shouldBlockQueryError(query.error, query.data))
		return { description: "Unavailable right now" };
	const vaults = query.data ?? [];
	return {
		description: agentOverviewSummary("vaults", vaults.length),
	};
}

export function useOverviewConnectorsModule({
	enabled = true,
	staticWhileLoading = false,
}: {
	enabled?: boolean;
	/** Show the empty summary instead of a skeleton until connections arrive. */
	staticWhileLoading?: boolean;
} = {}): AgentOverviewModuleContent {
	const connections = useConnections({ enabled });
	const connectedAppCount = useMemo(
		() =>
			new Set(
				(connections.data ?? [])
					.filter(isActiveConnection)
					.flatMap((connection) => (connection.app_name ? [connection.app_name] : [])),
			).size,
		[connections.data],
	);
	const description =
		staticWhileLoading && !connections.data ? (
			agentOverviewSummary("connectors", 0)
		) : connections.isLoading ? (
			<OverviewDescriptionSkeleton label="apps" />
		) : shouldBlockQueryError(connections.error, connections.data) ? (
			"Unavailable right now"
		) : (
			agentOverviewSummary("connectors", connectedAppCount)
		);
	return { description };
}
