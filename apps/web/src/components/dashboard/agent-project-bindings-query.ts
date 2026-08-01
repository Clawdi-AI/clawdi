"use client";

import { useMemo } from "react";
import { orderedAgentProjectBindings } from "@/components/dashboard/agent-project-scope";
import { useOpenApi } from "@/lib/api";

export function agentProjectBindingsQueryKey(agentId: string | null | undefined) {
	return [
		"get",
		"/v1/agents/{agent_id}/project-bindings",
		{ params: { path: { agent_id: agentId ?? "" } } },
	] as const;
}

export function useAgentProjectBindings(
	agentId: string | null | undefined,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return useOpenApi().useQuery(
		"get",
		"/v1/agents/{agent_id}/project-bindings",
		{ params: { path: { agent_id: agentId ?? "" } } },
		{ enabled: enabled && Boolean(agentId) },
	);
}

/** Resolves bound Project ids to user-visible names without changing binding authority. */
export function useAgentOverviewProjects(
	agentId: string | null | undefined,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const api = useOpenApi();
	const bindings = useAgentProjectBindings(agentId, { enabled });
	const projects = api.useQuery(
		"get",
		"/v1/projects",
		{},
		{ enabled: enabled && bindings.isSuccess },
	);
	const names = useMemo(() => {
		const projectsById = new Map(
			(projects.data ?? []).map((project) => [project.id, project.name]),
		);
		return orderedAgentProjectBindings(bindings.data ?? []).flatMap((binding) => {
			const name = projectsById.get(binding.project_id)?.trim();
			return name ? [name] : [];
		});
	}, [bindings.data, projects.data]);

	return {
		bindings,
		names,
		isLoading: bindings.isLoading || (bindings.isSuccess && projects.isLoading),
		projectsError: projects.error,
	};
}
