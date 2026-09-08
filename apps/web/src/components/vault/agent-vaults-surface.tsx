"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { resolveAgentProjectScope } from "@/components/dashboard/agent-project-scope";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Skeleton } from "@/components/ui/skeleton";
import { VaultsSurface } from "@/components/vault/vaults-surface";
import { agentDetailQueryOptions } from "@/lib/agent-queries";
import { agentSectionHref } from "@/lib/agent-routes";
import { useOpenApi } from "@/lib/api";
import { shouldBlockQueryError } from "@/lib/query-state";
import { agentResourceScope } from "@/lib/resource-navigation";

export function AgentVaultsSurface({ agentId }: { agentId: string }) {
	return (
		<AgentResourceRouteGate
			agentId={agentId}
			returnHref={agentSectionHref(agentId, "projects")}
			returnLabel="Projects"
		>
			<AgentVaultInventory agentId={agentId} />
		</AgentResourceRouteGate>
	);
}

function AgentVaultInventory({ agentId }: { agentId: string }) {
	const api = useOpenApi();
	const queryClient = useQueryClient();
	const agent = useQuery(agentDetailQueryOptions(api, queryClient, agentId));
	const bindings = useAgentProjectBindings(agentId);
	let projectIds: string[] = [];
	let scopeError: unknown = null;
	if (bindings.data) {
		try {
			projectIds = resolveAgentProjectScope(
				bindings.data,
				agent.data?.default_project_id,
			).projectIds;
		} catch (error) {
			scopeError = error;
		}
	}
	const blocked = scopeError || shouldBlockQueryError(bindings.error, bindings.data);
	return (
		<div className="space-y-4">
			{bindings.error || scopeError ? (
				<div className={`${CENTERED_PAGE_WIDTH_CLASS.page} px-4 lg:px-6`}>
					<ApiErrorPanel
						error={scopeError ?? bindings.error}
						title="Couldn't load Agent Vault access"
						onRetry={() => {
							void bindings.refetch();
							void agent.refetch();
						}}
					/>
				</div>
			) : null}
			{blocked ? null : bindings.data === undefined ? (
				<Skeleton className="mx-6 h-24 rounded-lg" />
			) : (
				<VaultsSurface
					agentProjectIds={projectIds}
					workspaceProjectId={
						bindings.data.find((binding) => binding.binding_type === "primary")?.project_id
					}
					navigationScope={agentResourceScope(agentId)}
				/>
			)}
		</div>
	);
}
