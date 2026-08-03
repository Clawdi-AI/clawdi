"use client";

import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { effectiveAgentProjectIds } from "@/components/dashboard/agent-project-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { VaultsSurface } from "@/components/vault/vaults-surface";
import type { AgentRouteSearch } from "@/lib/agent-routes";
import { shouldBlockQueryError } from "@/lib/query-state";
import { agentResourceScope } from "@/lib/resource-navigation";

export function AgentVaultsTab({
	agentId,
	routeSearch,
}: {
	agentId: string;
	routeSearch: AgentRouteSearch;
}) {
	const bindings = useAgentProjectBindings(agentId);

	if (bindings.isLoading) {
		return (
			<div className="space-y-4" data-testid="agent-vaults-loading">
				<Skeleton className="h-4 w-96 max-w-full" />
				<Skeleton className="h-10 w-full" />
				<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
					{Array.from({ length: 3 }).map((_, index) => (
						<Skeleton key={index} className="h-36 rounded-lg" />
					))}
				</div>
			</div>
		);
	}

	if (shouldBlockQueryError(bindings.error, bindings.data)) {
		return (
			<ApiErrorPanel
				error={bindings.error}
				onRetry={() => {
					void bindings.refetch();
				}}
				title="Couldn't load agent Projects"
			/>
		);
	}

	const projectIds = effectiveAgentProjectIds(bindings.data ?? []);
	return (
		<VaultsSurface
			embedded
			agentProjectIds={projectIds}
			navigationScope={agentResourceScope(agentId, routeSearch)}
		/>
	);
}
