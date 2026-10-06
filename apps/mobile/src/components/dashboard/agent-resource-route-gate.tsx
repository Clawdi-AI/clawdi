import { resolveAgentProjectScope, resolveAgentWorkspaceProjectId } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { LibraryPage } from "@/components/detail/layout";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useMobileApi } from "@/lib/api-provider";
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
	let allowed = false;
	let resolvedProject = projectId;
	if (agent.data && bindings.data && !agent.isError && !bindings.isError) {
		try {
			resolvedProject =
				projectId ??
				(workspaceFallback
					? (resolveAgentWorkspaceProjectId(bindings.data, agent.data.default_project_id) ??
						undefined)
					: undefined);
			allowed = Boolean(
				resolvedProject &&
					resolveAgentProjectScope(
						bindings.data,
						agent.data.default_project_id,
					).projectIds.includes(resolvedProject),
			);
		} catch {
			allowed = false;
		}
	}
	if (agentId && (projectId || workspaceFallback) && (agent.isPending || bindings.isPending))
		return (
			<LibraryPage>
				<RouteLoadingSkeleton />
			</LibraryPage>
		);
	if (!allowed)
		return (
			<LibraryPage>
				<ApiErrorPanel
					error={agent.error ?? bindings.error}
					title="Project unavailable"
					onRetry={() => {
						void agent.refetch();
						void bindings.refetch();
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
