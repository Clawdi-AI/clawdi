"use client";

import { useMemo } from "react";
import {
	type AgentProjectBinding,
	orderedAgentProjectBindings,
} from "@/components/dashboard/agent-project-scope";
import { useOpenApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";

type ProjectRow = components["schemas"]["ProjectResponse"];

export function resolveAgentOverviewProjectNames(
	bindings: readonly AgentProjectBinding[],
	projects: readonly ProjectRow[],
) {
	const projectsById = new Map(projects.map((project) => [project.id, project.name]));
	const names = orderedAgentProjectBindings(bindings).flatMap((binding) => {
		const name = projectsById.get(binding.project_id)?.trim();
		return name ? [name] : [];
	});
	return { names, unresolvedCount: Math.max(0, bindings.length - names.length) };
}

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
		{ enabled: enabled && bindings.isSuccess && (bindings.data?.length ?? 0) > 0 },
	);
	const resolvedNames = useMemo(() => {
		return resolveAgentOverviewProjectNames(bindings.data ?? [], projects.data ?? []);
	}, [bindings.data, projects.data]);

	return {
		bindings,
		nameResolution: {
			...resolvedNames,
			isLoading: (bindings.data?.length ?? 0) > 0 && projects.isLoading,
			error: projects.error,
			refetch: projects.refetch,
		},
	};
}
