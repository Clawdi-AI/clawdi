"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailNotFound } from "@/components/detail/layout";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Skeleton } from "@/components/ui/skeleton";
import { type AdapterModule, connectedAdapterHasModule } from "@/lib/adapter-modules";
import { agentOwnershipKindFromId, useAgentOwnership } from "@/lib/agent-ownership";
import { agentDetailQueryOptions } from "@/lib/agent-queries";
import { useOpenApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

/** Fail closed before a nested Agent route can read or mutate an account resource. */
export function AgentResourceRouteGate({
	agentId,
	returnHref,
	returnLabel,
	projectAccess,
	requiredAdapterModule,
	children,
}: {
	agentId: string;
	returnHref: string;
	returnLabel: string;
	projectAccess?: { projectId: string | null | undefined };
	requiredAdapterModule?: AdapterModule;
	children: ReactNode;
}) {
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const ownership = useAgentOwnership();
	const agent = useQuery(agentDetailQueryOptions($api, queryClient, agentId));
	const ownershipKind = agent.data
		? agentOwnershipKindFromId(agent.data.id, ownership)
		: "unresolved";
	const blockingError =
		isApiNotFoundError(agent.error) || shouldBlockQueryError(agent.error, agent.data)
			? agent.error
			: null;

	if (
		agent.isLoading ||
		(requiredAdapterModule && agent.data !== undefined && ownershipKind === "unresolved")
	) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-4 px-4 lg:px-6")}>
				<DetailBackLink href="/agents" label="Agents" mobileOnly={false} />
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-24 w-full rounded-lg" />
			</div>
		);
	}

	if (blockingError || !agent.data) {
		const agentMissing = isApiNotFoundError(blockingError) || (!blockingError && !agent.data);
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-4 px-4 lg:px-6")}>
				<DetailBackLink
					href={agentMissing ? "/agents" : returnHref}
					label={agentMissing ? "Agents" : returnLabel}
					mobileOnly={false}
				/>
				{agentMissing ? (
					<DetailNotFound
						title="Agent not found"
						message="This Agent does not exist or is no longer available."
					/>
				) : (
					<ApiErrorPanel
						error={blockingError}
						onRetry={() => {
							void agent.refetch();
						}}
						title="Couldn't verify Agent access"
					/>
				)}
			</div>
		);
	}

	if (
		requiredAdapterModule &&
		ownershipKind !== "cloud" &&
		!connectedAdapterHasModule(agent.data.adapter_modules, requiredAdapterModule)
	) {
		const label = requiredAdapterModule === "sessions" ? "Sessions" : "Skills";
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-4 px-4 lg:px-6")}>
				<DetailBackLink href={returnHref} label={returnLabel} mobileOnly={false} />
				<DetailNotFound
					title={`${label} unavailable`}
					message={`This Connected Agent does not provide ${label.toLowerCase()} sync.`}
				/>
			</div>
		);
	}

	return projectAccess ? (
		<AgentProjectAccessGate
			agentId={agentId}
			projectId={projectAccess.projectId}
			returnHref={returnHref}
			returnLabel={returnLabel}
		>
			{children}
		</AgentProjectAccessGate>
	) : (
		children
	);
}

/** Resolve explicit Project access only after the Agent identity gate succeeds. */
function AgentProjectAccessGate({
	agentId,
	projectId: rawProjectId,
	returnHref,
	returnLabel,
	children,
}: {
	agentId: string;
	projectId: string | null | undefined;
	returnHref: string;
	returnLabel: string;
	children: ReactNode;
}) {
	const projectId = rawProjectId?.trim() || null;
	const bindings = useAgentProjectBindings(agentId, { enabled: Boolean(projectId) });
	const blockingError = projectId
		? shouldBlockQueryError(bindings.error, bindings.data)
			? bindings.error
			: null
		: null;
	const projectIsBound = Boolean(
		projectId && bindings.data?.some((binding) => binding.project_id === projectId),
	);

	if (projectId && bindings.isLoading) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-4 px-4 lg:px-6")}>
				<DetailBackLink href={returnHref} label={returnLabel} mobileOnly={false} />
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-24 w-full rounded-lg" />
			</div>
		);
	}

	if (blockingError || !projectIsBound) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-4 px-4 lg:px-6")}>
				<DetailBackLink href={returnHref} label={returnLabel} mobileOnly={false} />
				{blockingError ? (
					<ApiErrorPanel
						error={blockingError}
						onRetry={() => {
							void bindings.refetch();
						}}
						title="Couldn't verify Workspace or Project access"
					/>
				) : (
					<DetailNotFound
						title="Project not available to this Agent"
						message={
							projectId
								? "The requested Project is not available through this Agent. Choose an available Project first."
								: "Choose the Workspace or a linked Project before opening its Skills or Vaults."
						}
					/>
				)}
			</div>
		);
	}

	return children;
}
