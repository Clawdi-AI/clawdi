"use client";

import { useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	ConnectedAgentDetail,
	ConnectedAgentDetailSkeleton,
} from "@/components/dashboard/connected-agent-detail";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { HostedAgentDetail } from "@/hosted/agents/hosted-agent-detail";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { defaultDeploymentRuntime, deploymentFilesUrl, isHostedRuntime } from "@/hosted/runtimes";
import {
	type AgentRouteSearch,
	type AgentSectionId,
	agentRouteBelongsToSection,
	agentRouteOwnsSection,
	CONNECTED_AGENT_SECTION_IDS,
	HOSTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { useDeploymentEventStreamActive } from "@/lib/deployment-event-stream-context";
import { hostedAgentVisibleSectionIds } from "@/lib/navigation-model";

export async function runManualDeploymentRefetch(
	refetch: () => Promise<unknown>,
	setManualChecking: (checking: boolean) => void,
): Promise<void> {
	setManualChecking(true);
	try {
		await refetch();
	} finally {
		setManualChecking(false);
	}
}

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
	routeSearch,
	standalone = false,
}: {
	environmentId: string;
	section: AgentSectionId;
	routeSearch: AgentRouteSearch;
	standalone?: boolean;
}) {
	const router = useRouter();
	const pathname = useLocation({ select: (location) => location.pathname });
	const eventStreamActive = useDeploymentEventStreamActive();
	const {
		deployment,
		environmentId: resolvedEnvId,
		matchedRuntime,
		membershipResolved,
		isLoading,
		deploymentTransitionTimedOut,
		deploymentTransitionEscalated,
		error,
		refetch,
	} = useAgentDeployment(environmentId, eventStreamActive);
	const manualCheckInFlightRef = useRef(false);
	const [manualChecking, setManualChecking] = useState(false);
	const ownsCurrentSection =
		agentRouteOwnsSection(pathname, environmentId, section) ||
		(section === "plugins" && agentRouteBelongsToSection(pathname, environmentId, section));
	const hostedSectionIds = deployment
		? hostedAgentVisibleSectionIds(deploymentFilesUrl(deployment) !== null)
		: HOSTED_AGENT_SECTION_IDS;
	const hostedSection = hostedSectionIds.some((candidate) => candidate === section);
	const connectedSection = CONNECTED_AGENT_SECTION_IDS.some((candidate) => candidate === section);

	// Canonicalize exact section roots and nested Plugins routes, while a stale
	// rendered match cannot rewrite a newer route.
	useEffect(() => {
		if (!ownsCurrentSection) return;

		if (deployment) {
			if (!hostedSection) {
				void router.navigate({
					to: "/agents/$id",
					params: { id: environmentId },
					search: {},
					replace: true,
				});
			}
			return;
		}

		if (membershipResolved && !connectedSection) {
			void router.navigate({
				to: "/agents/$id",
				params: { id: environmentId },
				search: {},
				replace: true,
			});
		}
	}, [
		connectedSection,
		deployment,
		environmentId,
		hostedSection,
		membershipResolved,
		ownsCurrentSection,
		router,
		section,
	]);

	const handleCheckAgain = async () => {
		if (manualCheckInFlightRef.current) return;
		manualCheckInFlightRef.current = true;
		try {
			await runManualDeploymentRefetch(refetch, setManualChecking);
		} finally {
			manualCheckInFlightRef.current = false;
		}
	};

	// No route may be classified as connected until deployment membership has
	// produced at least one authoritative snapshot. A 403/network failure is not
	// an empty deployment list.
	if (!membershipResolved && !deployment) {
		if (error) {
			return (
				<div
					data-hosted="true"
					className={`${CENTERED_PAGE_WIDTH_CLASS.page} space-y-4 px-4 py-2 lg:px-6`}
				>
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={error}
						onRetry={() => {
							void refetch();
						}}
						title="Clawdi Cloud inventory unavailable"
					/>
				</div>
			);
		}
		return <ConnectedAgentDetailSkeleton hosted section={section} />;
	}

	// Hold a skeleton until the deployment lookup settles, so a hosted agent
	// doesn't flash the connected detail (and fire its queries) first.
	if (isLoading) {
		return <ConnectedAgentDetailSkeleton hosted section={section} />;
	}

	if (deployment) {
		// Scope the detail to the deployment's selected runtime.
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
				routeSearch={routeSearch}
				onDeleteAccepted={() => router.navigate({ href: "/", replace: true })}
				deploymentTransitionTimedOut={deploymentTransitionTimedOut}
				deploymentTransitionEscalated={deploymentTransitionEscalated}
				isCheckingDeployment={manualChecking}
				onCheckDeploymentAgain={() => void handleCheckAgain()}
				eventStreamActive={eventStreamActive}
				standalone={standalone}
			/>
		);
	}

	return <ConnectedAgentDetail environmentId={environmentId} section={section} />;
}
