import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { isCustomProject } from "@/components/projects/project-metadata";
import { useOpenApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import { shouldBlockQueryError } from "@/lib/query-state";

/** Browsing an account Project does not grant the Agent runtime access to it. */
export function useAgentProjectBrowseAccess(
	agentId: string | null | undefined,
	projectId: string | null | undefined,
) {
	const enabled = Boolean(agentId && projectId);
	const bindings = useAgentProjectBindings(agentId, { enabled });
	const bound = Boolean(
		projectId && bindings.data?.some((binding) => binding.project_id === projectId),
	);
	const projects = useOpenApi().useQuery("get", "/v1/projects", {}, { enabled: enabled && !bound });
	const error = !enabled
		? null
		: shouldBlockQueryError(bindings.error, bindings.data)
			? bindings.error
			: !bound &&
					(isApiNotFoundError(projects.error) ||
						shouldBlockQueryError(projects.error, projects.data))
				? projects.error
				: null;
	return {
		readable:
			enabled &&
			!error &&
			(bound ||
				Boolean(
					projects.data?.some((project) => project.id === projectId && isCustomProject(project)),
				)),
		isLoading: enabled && (bindings.isLoading || (!bound && projects.isLoading)),
		error,
		refetch: () => Promise.all([bindings.refetch(), projects.refetch()]),
	};
}
