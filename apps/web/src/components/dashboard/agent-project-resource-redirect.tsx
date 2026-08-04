"use client";

import { Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { orderedAgentProjectBindings } from "@/components/dashboard/agent-project-scope";
import { DetailNotFound } from "@/components/detail/layout";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type AgentRouteSearch,
	agentDeploymentRouteQuery,
	agentProjectDetailHref,
	agentSectionHref,
} from "@/lib/agent-routes";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

/** Compatibility bridge from the retired flat Skills/Vaults pools to one Project context. */
export function AgentProjectResourceRedirect({
	agentId,
	resource,
	routeSearch,
}: {
	agentId: string;
	resource: "skills" | "vaults";
	routeSearch: AgentRouteSearch;
}) {
	const router = useRouter();
	const bindings = useAgentProjectBindings(agentId);
	const orderedBindings = useMemo(
		() => orderedAgentProjectBindings(bindings.data ?? []),
		[bindings.data],
	);
	const requestedProjectId =
		typeof routeSearch.project === "string" && routeSearch.project.trim()
			? routeSearch.project.trim()
			: null;
	const requestedBinding = requestedProjectId
		? orderedBindings.find((binding) => binding.project_id === requestedProjectId)
		: null;
	const defaultBinding =
		orderedBindings.find((binding) => binding.binding_type === "primary") ??
		orderedBindings[0] ??
		null;
	const targetBinding = requestedProjectId ? requestedBinding : defaultBinding;
	const blockingError = shouldBlockQueryError(bindings.error, bindings.data)
		? bindings.error
		: null;
	const targetHref = targetBinding
		? `${agentProjectDetailHref(
				agentId,
				targetBinding.project_id,
				agentDeploymentRouteQuery(routeSearch),
			)}#${resource}`
		: null;

	useEffect(() => {
		if (!targetHref || blockingError) return;
		void router.navigate({ href: targetHref, replace: true, resetScroll: false });
	}, [blockingError, router, targetHref]);

	const projectsHref = agentSectionHref(
		agentId,
		"projects",
		agentDeploymentRouteQuery(routeSearch),
	);
	if (bindings.isLoading || (targetHref && !blockingError)) {
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
					Back to Agent Projects
				</Button>
				<Skeleton className="h-8 w-52" />
				<Skeleton className="h-24 w-full rounded-lg" />
			</div>
		);
	}

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
				Back to Agent Projects
			</Button>
			{blockingError ? (
				<ApiErrorPanel
					error={blockingError}
					onRetry={() => {
						void bindings.refetch();
					}}
					title="Couldn't load Agent Project access"
				/>
			) : requestedProjectId ? (
				<DetailNotFound
					title="Project not available to this Agent"
					message="The requested Project is not in this Agent's effective access scope. Choose an available Project first."
				/>
			) : (
				<DetailNotFound
					title="Default project unavailable"
					message="This Agent has no effective Project context yet. Return to Agent Projects and retry after its primary binding is available."
				/>
			)}
		</div>
	);
}
