import { resolveAgentProjectScope, resolveAgentWorkspaceProjectId } from "@clawdi/shared/api";
import { isCustomProject } from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { LibraryPage } from "@/components/detail/layout";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

export function AgentResourceRouteGate({
	agentId,
	projectId,
	children,
	workspaceFallback = false,
}: {
	agentId?: string;
	projectId?: string;
	children: ReactNode | ((projectId: string) => ReactNode);
	workspaceFallback?: boolean;
}) {
	const t = useI18n();
	const agent = useCloudAgent(agentId);
	const scope = useAccountScope(),
		read = useAccountRead(),
		{ agentProjects } = useMobileApi();
	const bindings = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-bindings", agentId),
		enabled: scope.isReady && Boolean(agentId),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => agentProjects.listBindings(agentId ?? "", lease), signal),
	});
	// Like Web's useAgentProjectBrowseAccess: browsing the user's own Project is allowed even
	// when the Agent isn't linked to it; that grants the Agent runtime no access.
	const projects = useCloudProjects();
	let bound = false;
	let resolvedProject = projectId;
	if (agent.data && bindings.data && !agent.isError && !bindings.isError) {
		try {
			resolvedProject =
				projectId ??
				(workspaceFallback
					? (resolveAgentWorkspaceProjectId(bindings.data, agent.data.default_project_id) ??
						undefined)
					: undefined);
			bound = Boolean(
				resolvedProject &&
					resolveAgentProjectScope(
						bindings.data,
						agent.data.default_project_id,
					).projectIds.includes(resolvedProject),
			);
		} catch {
			bound = false;
		}
	}
	const owned = Boolean(
		agent.data &&
			resolvedProject &&
			!projects.isError &&
			projects.data?.some((project) => project.id === resolvedProject && isCustomProject(project)),
	);
	const allowed = bound || owned;
	if (
		agentId &&
		(projectId || workspaceFallback) &&
		(agent.isPending || bindings.isPending || (!bound && projects.isPending))
	)
		return (
			<LibraryPage>
				<RouteLoadingSkeleton />
			</LibraryPage>
		);
	if (!allowed)
		return (
			<LibraryPage>
				<ApiErrorPanel
					error={agent.error ?? bindings.error ?? projects.error}
					title={t("projects.unavailable")}
					onRetry={() => {
						void agent.refetch();
						void bindings.refetch();
						void projects.refetch();
					}}
				/>
			</LibraryPage>
		);
	return typeof children === "function"
		? resolvedProject
			? children(resolvedProject)
			: null
		: children;
}
