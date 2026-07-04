"use client";

import { useLocation } from "@tanstack/react-router";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	ConnectedAgentDetail,
	ConnectedAgentDetailSkeleton,
} from "@/components/dashboard/connected-agent-detail";
import { EmptyState } from "@/components/empty-state";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { isCloudEnvId } from "@/hosted/agent-identity";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { HostedAgentDetail } from "@/hosted/agents/hosted-agent-detail";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { defaultDeploymentRuntime, isHostedRuntime } from "@/hosted/runtimes";
import type { AgentSectionId } from "@/lib/agent-routes";

/**
 * Agent home for hosted builds. An agent backed by a hosted deployment renders
 * the hosted agent detail (`HostedAgentDetail`); a connected agent — or one
 * we can't resolve to a deployment — falls back to the connected detail.
 * The deployment lookup is hosted-only data, so the whole branch lives here
 * behind the IS_HOSTED dynamic import.
 */
export function AgentHome({
	environmentId,
	section,
}: {
	environmentId: string;
	section: AgentSectionId;
}) {
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const searchParams = new URLSearchParams(searchStr);
	const {
		deployment,
		environmentId: resolvedEnvId,
		matchedRuntime,
		isLoading,
		isFetching,
		error,
	} = useAgentDeployment(environmentId);
	const requestedHostedAgent =
		searchParams.get("source") === "on-clawdi" || !isCloudEnvId(environmentId);

	// Hold a skeleton until the deployment lookup settles, so a hosted agent
	// doesn't flash the connected detail (and fire its queries) first.
	if (isLoading || (requestedHostedAgent && !deployment && isFetching)) {
		return <ConnectedAgentDetailSkeleton hosted />;
	}

	if (error && requestedHostedAgent) {
		return (
			<div
				data-hosted="true"
				className={`${CENTERED_PAGE_WIDTH_CLASS.page} space-y-4 px-4 py-2 lg:px-6`}
			>
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={error}
					title="Couldn’t load hosted agent"
				/>
			</div>
		);
	}

	if (deployment) {
		// Scope the detail to a single runtime. Prefer the env's matched runtime;
		// fall back to the deployment default when the route used a deployment id.
		const runtime =
			matchedRuntime && isHostedRuntime(matchedRuntime)
				? matchedRuntime
				: defaultDeploymentRuntime(deployment);
		return (
			<HostedAgentDetail
				environmentId={resolvedEnvId}
				deployment={deployment}
				runtime={runtime}
				section={section}
			/>
		);
	}

	if (requestedHostedAgent) {
		return (
			<div
				data-hosted="true"
				className={`${CENTERED_PAGE_WIDTH_CLASS.page} space-y-4 px-4 py-2 lg:px-6`}
			>
				<EmptyState
					title="Clawdi Cloud agent not found"
					description="This Clawdi Cloud agent may still be provisioning or may have been removed."
				/>
			</div>
		);
	}

	return <ConnectedAgentDetail environmentId={environmentId} section={section} />;
}
