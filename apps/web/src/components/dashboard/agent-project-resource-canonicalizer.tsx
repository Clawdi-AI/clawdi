"use client";

import { Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { resolveAgentProjectResourceContext } from "@/components/dashboard/agent-project-resource-context";
import { orderedAgentProjectBindings } from "@/components/dashboard/agent-project-scope";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type AgentRouteSearch,
	agentDeploymentRouteQuery,
	agentProjectResourceHref,
	agentSectionHref,
} from "@/lib/agent-routes";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

type ProjectResourceSection = "skills" | "vaults";

export function AgentProjectResourceCanonicalizer({
	agentId,
	resource,
	routeSearch,
}: {
	agentId: string;
	resource: ProjectResourceSection;
	routeSearch: AgentRouteSearch;
}) {
	const projectsHref = agentSectionHref(
		agentId,
		"projects",
		agentDeploymentRouteQuery(routeSearch),
	);
	return (
		<AgentResourceRouteGate agentId={agentId} returnHref={projectsHref} returnLabel="Projects">
			<CanonicalizeProjectResource
				agentId={agentId}
				resource={resource}
				routeSearch={routeSearch}
				projectsHref={projectsHref}
			/>
		</AgentResourceRouteGate>
	);
}

function CanonicalizeProjectResource({
	agentId,
	resource,
	routeSearch,
	projectsHref,
}: {
	agentId: string;
	resource: ProjectResourceSection;
	routeSearch: AgentRouteSearch;
	projectsHref: string;
}) {
	const router = useRouter();
	const requestedProjectId =
		typeof routeSearch.project === "string" && routeSearch.project.trim()
			? routeSearch.project.trim()
			: null;
	const bindings = useAgentProjectBindings(agentId);
	const orderedBindings = useMemo(
		() => orderedAgentProjectBindings(bindings.data ?? []),
		[bindings.data],
	);
	const resolvedProjectId = resolveAgentProjectResourceContext(orderedBindings, requestedProjectId);
	const blockingError = shouldBlockQueryError(bindings.error, bindings.data)
		? bindings.error
		: null;
	const targetHref = resolvedProjectId
		? agentProjectResourceHref(
				agentId,
				resolvedProjectId,
				resource,
				agentDeploymentRouteQuery(routeSearch),
			)
		: projectsHref;
	const canCanonicalize = bindings.data !== undefined;

	useEffect(() => {
		if (!canCanonicalize || blockingError) return;
		void router.navigate({ href: targetHref, replace: true, resetScroll: false });
	}, [blockingError, canCanonicalize, router, targetHref]);

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-4 px-4 lg:px-6")}>
			<Button
				render={<Link to={projectsHref} />}
				nativeButton={false}
				variant="ghost"
				size="sm"
				className="w-fit"
			>
				<ArrowLeft className="size-4" />
				Back to Projects
			</Button>
			{blockingError ? (
				<ApiErrorPanel
					error={blockingError}
					onRetry={() => {
						void bindings.refetch();
					}}
					title="Couldn't load Workspace or Project access"
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
