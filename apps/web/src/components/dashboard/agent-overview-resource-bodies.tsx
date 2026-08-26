"use client";

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
		description: total ? `${total} ${total === 1 ? "skill" : "skills"}` : "No skills installed",
	};
}

export function overviewProjectsModule({
	bindings,
}: {
	bindings: SummaryState & { count: number | null };
}): AgentOverviewModuleContent {
	if (bindings.isLoading) return { description: <OverviewDescriptionSkeleton label="projects" /> };
	if (bindings.isUnavailable) return { description: "Unavailable right now" };
	if (bindings.error) return { description: "Unavailable right now" };
	const count = bindings.count ?? 0;
	const primary = count
		? `${count} linked ${count === 1 ? "Project" : "Projects"}`
		: "No Projects linked";
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
	if (resolution === "unavailable" || query.error) return { description: "Unavailable right now" };
	return overviewWorkspaceSkillsModule([
		...skillKeys,
		...(query.data ?? []).map((skill) => skill.skill_key),
	]);
}

export function useOverviewMemoriesModule({
	enabled = true,
}: {
	enabled?: boolean;
} = {}): AgentOverviewModuleContent {
	const api = useApi();
	const query = useQuery({
		queryKey: ["memories", "", "", 0, 1],
		queryFn: async () =>
			unwrap(await api.GET("/v1/memories", { params: { query: { page: 1, page_size: 1 } } })),
		enabled,
	});
	if (query.isLoading) return { description: <OverviewDescriptionSkeleton label="memories" /> };
	if (query.error) return { description: "Unavailable right now" };
	const total = query.data?.total ?? 0;
	return {
		description: total
			? `${total} ${total === 1 ? "memory" : "memories"} · All agents`
			: "No memories yet · All agents",
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

export function useOverviewConnectorsModule({
	enabled = true,
}: {
	enabled?: boolean;
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
	const description = connections.isLoading ? (
		<OverviewDescriptionSkeleton label="apps" />
	) : connections.error ? (
		"Unavailable right now"
	) : connectedAppCount ? (
		`${connectedAppCount} ${connectedAppCount === 1 ? "app" : "apps"} available to all Agents`
	) : (
		"No apps available to any Agent"
	);
	return { description };
}
