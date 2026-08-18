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
	agentRouteSearch,
	agentSectionHref,
	agentSkillDetailHref,
} from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { decodeResourceRouteParam } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { useCommittedRouteIsLatestTarget } from "@/lib/use-committed-location";
import { cn } from "@/lib/utils";
import { SkillDetailContent } from "@/pages/dashboard/skills/[key]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/skills/$")({
	head: () => routeHeadTitle("Skill"),
	component: AgentSkillDetailRoute,
});

function AgentSkillDetailRoute() {
	const { id, _splat } = Route.useParams();
	const search = Route.useSearch();
	const skillKey = (_splat ?? "").split("/").map(decodeResourceRouteParam).join("/");
	const projectId =
		typeof search.project === "string" && search.project.trim() ? search.project.trim() : null;
	const returnHref = agentSectionHref(id, "projects", agentRouteSearch(search));

	if (!projectId) {
		return (
			<AgentResourceRouteGate agentId={id} returnHref={returnHref} returnLabel="Projects">
				<LegacyAgentSkillProjectCanonicalizer agentId={id} skillKey={skillKey} search={search} />
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
			<SkillDetailContent agentId={id} skillKey={skillKey} routeSearch={search} />
		</AgentResourceRouteGate>
	);
}

function LegacyAgentSkillProjectCanonicalizer({
	agentId,
	skillKey,
	search,
}: {
	agentId: string;
	skillKey: string;
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
	const projectsHref = agentSectionHref(agentId, "projects", agentRouteSearch(search));
	const targetHref = projectId
		? agentSkillDetailHref(agentId, skillKey, projectId, agentRouteSearch(search))
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
