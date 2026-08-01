"use client";

import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentProjectBindings } from "@/components/dashboard/agent-projects-tab";
import { Skeleton } from "@/components/ui/skeleton";
import { effectiveAgentProjectIds } from "@/components/vault/vault-scope";
import { VaultsSurface } from "@/components/vault/vaults-surface";

export function AgentVaultsTab({ agentId }: { agentId: string }) {
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

	if (bindings.error) {
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
	return <VaultsSurface embedded agentProjectIds={projectIds} />;
}
