"use client";

import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { effectiveAgentProjectIds } from "@/components/dashboard/agent-project-scope";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { VaultCardSkeleton, VaultsSurface } from "@/components/vault/vaults-surface";
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
			<div className={HERO_GRID_CLASS} data-testid="agent-vaults-loading">
				{Array.from({ length: 3 }).map((_, index) => (
					<VaultCardSkeleton key={index} />
				))}
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
				title="Couldn't load Workspace and Project Vault access"
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
