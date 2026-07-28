"use client";

import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { AlertCircle, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
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
import { deploymentDisplayName, isCloudEnvId } from "@/hosted/agent-identity";
import { type AgentDeploymentMatch, useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { HostedAgentDetail } from "@/hosted/agents/hosted-agent-detail";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { deploymentStatusFromResource, deploymentStatusLabel } from "@/hosted/deployment-status";
import { defaultDeploymentRuntime, isHostedRuntime } from "@/hosted/runtimes";
import {
	AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY,
	type AgentSectionId,
	agentDeploymentRouteQuery,
	agentDeploymentSelector,
	agentSectionHref,
	isAcceptedHostedAgentRoute,
	parseAgentPathname,
} from "@/lib/agent-routes";
import { formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const UNRESOLVED_HOSTED_AGENT_REFETCH_INTERVAL_MS = 5_000;
const UNRESOLVED_HOSTED_AGENT_MAX_REFETCH_ATTEMPTS = 24;

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
	const router = useRouter();
	const pathname = useLocation({ select: (location) => location.pathname });
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const searchParams = new URLSearchParams(searchStr);
	const locationAgentId = parseAgentPathname(pathname)?.agentId ?? null;
	const deploymentSelector = agentDeploymentSelector(searchParams);
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
	const requestedFromCloudRedirect = searchParams.get("source") === "on-clawdi";
	const acceptedSetupRoute = isAcceptedHostedAgentRoute(environmentId, searchParams);
	const requestedHostedAgent =
		requestedFromCloudRedirect || Boolean(deploymentSelector) || !isCloudEnvironmentId;
	const unresolvedHostedAgent =
		requestedHostedAgent && !deployment && ambiguousMatches.length === 0 && !error && !isLoading;
	const shouldAutoRefetchUnresolvedHostedAgent =
		unresolvedHostedAgent && (requestedFromCloudRedirect || isCloudEnvironmentId);
	const isFetchingRef = useRef(isFetching);
	const [acceptedSetupStatusTimedOut, setAcceptedSetupStatusTimedOut] = useState(false);

	// Canonicalize a resolved hosted route with its deployment selector before
	// Stop removes the env mapping. The selector is then sufficient to retain
	// detail ownership while the cloud-agent projection is absent. During a
	// pending route transition, the old match can briefly render against the new
	// location. Only that location's owner may canonicalize it.
	useEffect(() => {
		if (locationAgentId !== environmentId || !deployment || deploymentSelector) return;
		const query = new URLSearchParams(searchStr);
		query.set("source", "on-clawdi");
		query.set(AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY, deployment.resource.id);
		void router.navigate({
			href: agentSectionHref(environmentId, section, query),
			replace: true,
		});
	}, [deployment, deploymentSelector, environmentId, locationAgentId, router, searchStr, section]);

	useEffect(() => {
		isFetchingRef.current = isFetching;
	}, [isFetching]);

	useEffect(() => {
		setAcceptedSetupStatusTimedOut(false);
	}, [environmentId, deploymentSelector]);

	useEffect(() => {
		if (!shouldAutoRefetchUnresolvedHostedAgent || typeof window === "undefined") return;

		let attempts = 0;
		const intervalId = window.setInterval(() => {
			if (isFetchingRef.current) return;

			attempts += 1;
			void refetch();

			if (attempts >= UNRESOLVED_HOSTED_AGENT_MAX_REFETCH_ATTEMPTS) {
				window.clearInterval(intervalId);
				if (acceptedSetupRoute) setAcceptedSetupStatusTimedOut(true);
			}
		}, UNRESOLVED_HOSTED_AGENT_REFETCH_INTERVAL_MS);

		return () => {
			window.clearInterval(intervalId);
		};
	}, [acceptedSetupRoute, refetch, shouldAutoRefetchUnresolvedHostedAgent]);

	const handleCheckAgain = () => {
		if (isFetchingRef.current) return;
		void refetch();
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
		if (acceptedSetupRoute) {
			return <AcceptedAgentSetupState />;
		}
		return <ConnectedAgentDetailSkeleton hosted />;
	}

	// Hold a skeleton until the deployment lookup settles, so a hosted agent
	// doesn't flash the connected detail (and fire its queries) first.
	if (isLoading || (requestedHostedAgent && !deployment && isFetching)) {
		if (acceptedSetupRoute) {
			return <AcceptedAgentSetupState />;
		}
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
				searchStr={searchStr}
				matches={ambiguousMatches}
				isFetching={isFetching}
				onRetry={handleCheckAgain}
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
		return (
			<HostedAgentDetail
				environmentId={resolvedEnvId}
				deployment={deployment}
				runtime={runtime}
				section={section}
				onDeleteAccepted={() => router.navigate({ href: "/agents", replace: true })}
				deploymentTransitionTimedOut={deploymentTransitionTimedOut}
				isCheckingDeployment={isFetching}
				onCheckDeploymentAgain={handleCheckAgain}
			/>
		);
	}

	if (acceptedSetupRoute) {
		return (
			<AcceptedAgentSetupState
				isChecking={isFetching}
				onCheckAgain={handleCheckAgain}
				statusTimedOut={acceptedSetupStatusTimedOut}
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
						<Button type="button" variant="outline" size="sm" onClick={handleCheckAgain}>
							<RefreshCw /> Check again
						</Button>
					}
				/>
			</div>
		);
	}

	return <ConnectedAgentDetail environmentId={environmentId} section={section} />;
}

export function AcceptedAgentSetupState({
	statusTimedOut = false,
	isChecking = false,
	onCheckAgain,
}: {
	statusTimedOut?: boolean;
	isChecking?: boolean;
	onCheckAgain?: () => void;
}) {
	return (
		<div
			data-hosted="true"
			data-testid="accepted-agent-setup"
			className={`${CENTERED_PAGE_WIDTH_CLASS.page} space-y-4 px-4 py-2 lg:px-6`}
		>
			<EmptyState
				icon={statusTimedOut ? AlertCircle : <Spinner className="size-5" />}
				title={statusTimedOut ? "Agent status is unavailable" : "Starting your agent"}
				description={
					statusTimedOut
						? "Clawdi accepted your request, but couldn’t load a progress update within two minutes. Startup may still be continuing."
						: "Your request was accepted. Clawdi is preparing your agent now. This usually takes a few minutes."
				}
				action={
					statusTimedOut && onCheckAgain ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={isChecking}
							onClick={onCheckAgain}
						>
							{isChecking ? <Spinner className="size-3.5" /> : <RefreshCw />}
							Check again
						</Button>
					) : null
				}
			/>
		</div>
	);
}

function DeploymentChooser({
	environmentId,
	section,
	searchStr,
	matches,
	isFetching,
	onRetry,
}: {
	environmentId: string;
	section: AgentSectionId;
	searchStr: string;
	matches: readonly AgentDeploymentMatch[];
	isFetching: boolean;
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
							disabled={isFetching}
							onClick={onRetry}
						>
							{isFetching ? <Spinner className="size-3.5" /> : <RefreshCw />}
							Check again
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			<div className="grid max-w-2xl gap-2">
				{matches.map((match) => {
					const { deployment } = match;
					const name = deploymentDisplayName(
						deployment.resource.spec.name,
						deployment.resource.spec.runtime,
					);
					const query = {
						...agentDeploymentRouteQuery(searchStr),
						[AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY]: deployment.resource.id,
					};
					return (
						<Link
							key={deployment.resource.id}
							to={agentSectionHref(environmentId, section, query)}
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
									deploymentStatusLabel(deploymentStatusFromResource(deployment.resource.status)),
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
