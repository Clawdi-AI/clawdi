import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { resolveAgentProjectResourceContext } from "@/components/dashboard/agent-project-resource-context";
import { orderedAgentProjectBindings } from "@/components/dashboard/agent-project-scope";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type AgentRouteSearch,
	agentProjectResourceHref,
	agentSectionHref,
	agentVaultDetailHref,
} from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { shouldBlockQueryError } from "@/lib/query-state";
import { agentResourceScope } from "@/lib/resource-navigation";
import { useCommittedRouteIsLatestTarget } from "@/lib/use-committed-location";
import { cn } from "@/lib/utils";
import VaultDetailPage from "@/pages/dashboard/vault/[slug]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/vaults/$slug")({
	head: () => routeHeadTitle("Vault"),
	component: AgentVaultDetailRoute,
});

function AgentVaultDetailRoute() {
	const { id, slug } = Route.useParams();
	const search = Route.useSearch();
	const projectId =
		typeof search.project === "string" && search.project.trim() ? search.project.trim() : null;
	const returnHref = projectId
		? agentProjectResourceHref(id, projectId, "vaults")
		: agentSectionHref(id, "projects");

	if (!projectId) {
		return (
			<AgentResourceRouteGate agentId={id} returnHref={returnHref} returnLabel="Projects">
				<LegacyAgentVaultProjectCanonicalizer agentId={id} slug={slug} search={search} />
			</AgentResourceRouteGate>
		);
	}

	return (
		<AgentResourceRouteGate
			agentId={id}
			returnHref={returnHref}
			returnLabel="Projects"
			projectAccess={{ projectId }}
		>
			<VaultDetailPage slug={slug} scope={agentResourceScope(id, projectId)} />
		</AgentResourceRouteGate>
	);
}

function LegacyAgentVaultProjectCanonicalizer({
	agentId,
	slug,
	search,
}: {
	agentId: string;
	slug: string;
	search: AgentRouteSearch;
}) {
	const router = useRouter();
	const bindings = useAgentProjectBindings(agentId);
	const orderedBindings = useMemo(
		() => orderedAgentProjectBindings(bindings.data ?? []),
		[bindings.data],
	);
	const projectId = resolveAgentProjectResourceContext(orderedBindings, null);
	const blockingError = shouldBlockQueryError(bindings.error, bindings.data)
		? bindings.error
		: null;
	const projectsHref = agentSectionHref(agentId, "projects");
	const targetHref = projectId
		? agentVaultDetailHref(agentId, slug, {
				projectId,
				vaultId: typeof search.vault === "string" ? search.vault : undefined,
			})
		: projectsHref;
	const isLatestTarget = useCommittedRouteIsLatestTarget();

	useEffect(() => {
		if (bindings.data === undefined || blockingError || !isLatestTarget) return;
		void router.navigate({ href: targetHref, replace: true, resetScroll: false });
	}, [bindings.data, blockingError, isLatestTarget, router, targetHref]);

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-4 px-4 lg:px-6")}>
			{blockingError ? (
				<ApiErrorPanel
					error={blockingError}
					onRetry={() => {
						void bindings.refetch();
					}}
					title="Couldn't load Workspace access"
				/>
			) : (
				<>
					<Skeleton className="h-8 w-52" />
					<Skeleton className="h-24 w-full rounded-lg" />
				</>
			)}
		</div>
	);
}
