"use client";

import { focusManager } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { AlertCircle, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentDisplayName } from "@/components/dashboard/agent-label";
import {
	ConnectedAgentDetail,
	ConnectedAgentDetailSkeleton,
} from "@/components/dashboard/connected-agent-detail";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_CARD_BUTTON_FOCUS_CLASS,
	EntityHeader,
} from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { agentRouteTargetsHostedDeployment, isCloudEnvId } from "@/hosted/agent-route";
import { type AgentDeploymentMatch, useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { HostedAgentDetail } from "@/hosted/agents/hosted-agent-detail";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import {
	deploymentRuntimeStatusPresentation,
	deploymentStatusFromResource,
} from "@/hosted/deployment-status";
import { defaultDeploymentRuntime, isHostedRuntime } from "@/hosted/runtimes";
import {
	type AgentRouteSearch,
	type AgentSectionId,
	agentDeploymentSelector,
	agentRouteIdsEqual,
	agentRouteOwnsSection,
	agentRouteSource,
	agentSectionLink,
	bindAgentDeploymentSearch,
	CONNECTED_AGENT_SECTION_IDS,
	HOSTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const UNRESOLVED_HOSTED_AGENT_REFETCH_INTERVAL_MS = 5_000;
const UNRESOLVED_HOSTED_AGENT_MAX_REFETCH_ATTEMPTS = 24;

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
}: {
	environmentId: string;
	section: AgentSectionId;
	routeSearch: AgentRouteSearch;
}) {
	const router = useRouter();
	const pathname = useLocation({ select: (location) => location.pathname });
	const deploymentSelector = agentDeploymentSelector(routeSearch);
	const {
		deployment,
		environmentId: resolvedEnvId,
		matchedRuntime,
		ambiguousMatches,
		membershipResolved,
		isLoading,
		isFetching,
		deploymentTransitionTimedOut,
		error,
		refetch,
	} = useAgentDeployment(environmentId, deploymentSelector);
	const isCloudEnvironmentId = isCloudEnvId(environmentId);
	const routeSource = agentRouteSource(routeSearch);
	const requestedFromCloudRedirect = routeSource === "on-clawdi";
	const requestedHostedAgent = agentRouteTargetsHostedDeployment(
		environmentId,
		routeSource,
		deploymentSelector,
	);
	const unresolvedHostedAgent =
		requestedHostedAgent && !deployment && ambiguousMatches.length === 0 && !error && !isLoading;
	const shouldAutoRefetchUnresolvedHostedAgent =
		unresolvedHostedAgent && (requestedFromCloudRedirect || isCloudEnvironmentId);
	const isFetchingRef = useRef(isFetching);
	const manualCheckInFlightRef = useRef(false);
	const [manualChecking, setManualChecking] = useState(false);
	const ownsCurrentSection = agentRouteOwnsSection(pathname, environmentId, section);
	const hostedSection = HOSTED_AGENT_SECTION_IDS.some((candidate) => candidate === section);
	const connectedSection = CONNECTED_AGENT_SECTION_IDS.some((candidate) => candidate === section);

	// Hosted membership is asynchronous, so it cannot be resolved in beforeLoad.
	// Only the exact current section may add deployment identity or redirect an
	// unsupported section; a stale rendered match cannot rewrite a newer route.
	useEffect(() => {
		if (!ownsCurrentSection) return;

		if (deployment) {
			const deploymentId = deployment.resource.id;
			const selectorMatches = agentRouteIdsEqual(deploymentSelector, deploymentId);
			if (!hostedSection) {
				void router.navigate({
					to: "/agents/$id",
					params: { id: environmentId },
					search: (current) =>
						selectorMatches ? current : bindAgentDeploymentSearch(current, deploymentId),
					hash: true,
					replace: true,
				});
				return;
			}
			if (!selectorMatches) {
				void router.navigate({
					to: ".",
					search: (current) => bindAgentDeploymentSearch(current, deploymentId),
					hash: true,
					replace: true,
				});
			}
			return;
		}

		if (
			membershipResolved &&
			ambiguousMatches.length === 0 &&
			!requestedHostedAgent &&
			!connectedSection
		) {
			void router.navigate({
				to: "/agents/$id",
				params: { id: environmentId },
				search: (current) => current,
				hash: true,
				replace: true,
			});
		}
	}, [
		ambiguousMatches.length,
		connectedSection,
		deployment,
		deploymentSelector,
		environmentId,
		hostedSection,
		membershipResolved,
		ownsCurrentSection,
		requestedHostedAgent,
		router,
	]);

	useEffect(() => {
		isFetchingRef.current = isFetching;
	}, [isFetching]);

	useEffect(() => {
		if (!shouldAutoRefetchUnresolvedHostedAgent || typeof window === "undefined") return;

		let attempts = 0;
		const intervalId = window.setInterval(() => {
			if (!focusManager.isFocused() || isFetchingRef.current) return;

			attempts += 1;
			void refetch();

			if (attempts >= UNRESOLVED_HOSTED_AGENT_MAX_REFETCH_ATTEMPTS) {
				window.clearInterval(intervalId);
			}
		}, UNRESOLVED_HOSTED_AGENT_REFETCH_INTERVAL_MS);

		return () => {
			window.clearInterval(intervalId);
		};
	}, [refetch, shouldAutoRefetchUnresolvedHostedAgent]);

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
	if (!membershipResolved && !deployment && ambiguousMatches.length === 0) {
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
		return <ConnectedAgentDetailSkeleton hosted />;
	}

	// Hold a skeleton until the deployment lookup settles, so a hosted agent
	// doesn't flash the connected detail (and fire its queries) first.
	if (isLoading) {
		return <ConnectedAgentDetailSkeleton hosted />;
	}

	if (error && requestedHostedAgent && !deployment) {
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
					title="Couldn’t load hosted agent"
				/>
			</div>
		);
	}

	if (ambiguousMatches.length > 0) {
		return (
			<DeploymentChooser
				environmentId={environmentId}
				section={section}
				routeSearch={routeSearch}
				matches={ambiguousMatches}
				isChecking={manualChecking}
				onRetry={() => void handleCheckAgain()}
			/>
		);
	}

	if (deployment) {
		// Scope the detail to a single runtime. Prefer the env's matched runtime;
		// fall back to the deployment default when the route used a deployment id.
		const runtime =
			matchedRuntime && isHostedRuntime(matchedRuntime)
				? matchedRuntime
				: defaultDeploymentRuntime(deployment);
		const deploymentRouteSearch = bindAgentDeploymentSearch(routeSearch, deployment.resource.id);
		return (
			<HostedAgentDetail
				environmentId={resolvedEnvId}
				deployment={deployment}
				runtime={runtime}
				section={section}
				routeSearch={deploymentRouteSearch}
				onDeleteAccepted={() => router.navigate({ href: "/agents", replace: true })}
				deploymentTransitionTimedOut={deploymentTransitionTimedOut}
				isCheckingDeployment={manualChecking}
				onCheckDeploymentAgain={() => void handleCheckAgain()}
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
					description="This Clawdi Cloud agent may still be starting or may have been removed."
					action={
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={manualChecking}
							onClick={() => void handleCheckAgain()}
						>
							{manualChecking ? <Spinner className="size-3.5" /> : <RefreshCw />} Check again
						</Button>
					}
				/>
			</div>
		);
	}

	return (
		<ConnectedAgentDetail
			environmentId={environmentId}
			section={section}
			routeSearch={routeSearch}
		/>
	);
}

function DeploymentChooser({
	environmentId,
	section,
	routeSearch,
	matches,
	isChecking,
	onRetry,
}: {
	environmentId: string;
	section: AgentSectionId;
	routeSearch: AgentRouteSearch;
	matches: readonly AgentDeploymentMatch[];
	isChecking: boolean;
	onRetry: () => void;
}) {
	const hasUnknownStatus = matches.some(
		(match) => deploymentStatusFromResource(match.deployment.resource.status).kind === "unknown",
	);
	return (
		<div
			data-hosted="true"
			className={`${CENTERED_PAGE_WIDTH_CLASS.page} flex flex-col gap-4 px-4 py-2 lg:px-6`}
		>
			<PageHeader
				title="Choose an agent"
				description="More than one older agent shares this identity. Choose the one you want to manage."
			/>
			{hasUnknownStatus ? (
				<Alert data-hosted="true">
					<AlertCircle />
					<AlertTitle>Some agent statuses are unavailable</AlertTitle>
					<AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<span>We can’t determine every agent state right now.</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={isChecking}
							onClick={onRetry}
						>
							{isChecking ? <Spinner className="size-3.5" /> : <RefreshCw />}
							Check again
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			<div className="grid max-w-2xl gap-2">
				{matches.map((match) => {
					const { deployment } = match;
					const name = agentDisplayName({
						default_name: deployment.resource.name,
						agent_type: deployment.resource.spec.runtime,
					});
					return (
						<Link
							key={deployment.resource.id}
							{...agentSectionLink(
								environmentId,
								section,
								bindAgentDeploymentSearch(routeSearch, deployment.resource.id),
							)}
							aria-label={`Open ${name}`}
							className={cn(
								ENTITY_CARD_BASE,
								ENTITY_CARD_BUTTON_FOCUS_CLASS,
								"block transition-colors hover:bg-muted/50",
							)}
						>
							<EntityHeader
								icon={<AgentIcon agent={match.runtime} size="lg" />}
								title={name}
								meta={[
									deploymentRuntimeStatusPresentation(deployment.resource.status).label,
									`Created ${formatShortDate(deployment.resource.metadata.createdAt)}`,
								]}
								titleAdornment={
									<ChevronRight className="size-4 text-muted-foreground/60" aria-hidden />
								}
							/>
						</Link>
					);
				})}
			</div>
		</div>
	);
}
