"use client";

import type { components } from "@clawdi/shared/api";
import { createElement, useMemo } from "react";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { type DaemonStatusVisual, daemonStatusVisual } from "@/components/dashboard/daemon-status";
import { statusTextVariants } from "@/components/ui/status-badge";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import type { HostedDeployment, HostedDeploymentStatus } from "@/hosted/billing/contracts";
import { hasExistingCloudDeployments } from "@/hosted/cloud-deployment-management";
import {
	compactDeploymentFailureReason,
	type DeploymentFailurePresentation,
	deploymentFailureProjection,
	deploymentFailureReason,
} from "@/hosted/deployment-failure";
import {
	type DeploymentStatus,
	type DeploymentStatusTone,
	deploymentStatusFromResource,
	deploymentStatusLabel,
	deploymentStatusTone,
	isRunningStatus,
} from "@/hosted/deployment-status";
import {
	claimedEnvIdsFromDeployments,
	isHostedDeploymentVisible,
} from "@/hosted/hosted-agent-resolution";
import { HostedDeploymentTileAction } from "@/hosted/hosted-deployment-tile-action";
import { deploymentRuntime, runtimeEnvironmentId } from "@/hosted/runtimes";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";
import { AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY, agentSectionHref } from "@/lib/agent-routes";

type Env = components["schemas"]["AgentResponse"];
type DeploymentStatusInput = HostedDeploymentStatus | null;

const EMPTY_DEPLOYMENTS: HostedDeployment[] = [];

export interface HostedRuntimeStatusView {
	compute: DeploymentStatus;
	sync: DaemonStatusVisual | null;
	primary: {
		label: string;
		tone: DeploymentStatusTone;
		textClass: string;
	};
	secondary: {
		kind: DaemonStatusVisual["kind"] | "failure_reason";
		label: string;
		tooltip: string;
		textClass: string;
	} | null;
	active: boolean;
}

export function hostedRuntimeStatusView(
	deployment: DeploymentStatusInput,
	env: Env | null | undefined,
	failurePresentation?: DeploymentFailurePresentation | null,
): HostedRuntimeStatusView {
	const compute = deploymentStatusFromResource(deployment);
	const computeLabel = deploymentStatusLabel(compute);
	const computeTone = deploymentStatusTone(compute);
	const sync = env === undefined ? null : daemonStatusVisual(env, "on-clawdi");
	const computeIsRunning = isRunningStatus(compute);
	const failureReason = compute.kind === "failed" ? deploymentFailureReason(deployment) : null;
	let secondary: HostedRuntimeStatusView["secondary"] = null;
	if (failureReason) {
		secondary = {
			kind: "failure_reason",
			label: failurePresentation
				? compactDeploymentFailureReason(
						`${failurePresentation.title}: ${failurePresentation.reason}`,
					)
				: `Failure: ${compactDeploymentFailureReason(failureReason)}`,
			tooltip: failurePresentation
				? `${failurePresentation.title}. ${failurePresentation.description} Reason: ${failurePresentation.reason}`
				: failureReason,
			textClass: statusTextVariants({ status: "destructive" }),
		};
	} else if (computeIsRunning && sync && sync.kind !== "live") {
		secondary = {
			kind: sync.kind,
			label: sync.badgeLabel,
			tooltip: sync.tooltip,
			textClass: sync.textClass,
		};
	}

	return {
		compute,
		sync,
		primary: {
			label: computeLabel,
			tone: computeTone,
			textClass: statusTextVariants({ status: computeTone }),
		},
		secondary,
		active: computeIsRunning,
	};
}

/**
 * Bridges hosted deploy API `Deployment` records to the unified `AgentTile`
 * shape rendered by `AgentsCard`. Hosted-side projection lives here so
 * `AgentsCard` itself never imports from `@/hosted/*`.
 *
 * `cloudEnvs` is the cloud-api environments list the parent already
 * fetches for the self-managed grid; passing it through lets each
 * hosted tile attach its matching `EnvironmentResponse` (joined via the
 * stored environment id projected by the deploy API). With the join, the same
 * agent identity can carry its avatar and sort order without making the
 * Cloud API projection authoritative for deployment state.
 */
export function useHostedAgentTiles({
	cloudEnvs,
	includeDeployments = true,
}: {
	cloudEnvs: Env[];
	includeDeployments?: boolean;
}) {
	const inventory = useHostedDeploymentInventory({ enabled: includeDeployments });
	const deployments = inventory.deployments ?? EMPTY_DEPLOYMENTS;

	// Memoize the env-by-id index so the tile join is O(N+M) instead
	// of O(N×M) on every render of the hosted-agent grid.
	//
	// Both index keys and lookup keys are forced lowercase. PostgreSQL
	// stores UUIDs case-insensitively by convention but emits them
	// lowercase via asyncpg; the deploy API could in principle hand us
	// mixed case at the rim. Comparing as-stored would silently miss a
	// real match, leaving both a hosted tile and a self-managed tile
	// for the same env. Normalize at the boundary, not the comparison site.
	const envById = useMemo(() => {
		const m = new Map<string, Env>();
		for (const e of cloudEnvs) m.set(e.id.toLowerCase(), e);
		return m;
	}, [cloudEnvs]);

	// Both `tiles` and `claimedEnvIds` derive from the last resolved inventory. Memoize
	// them so refetchInterval (10s for transient deployments) doesn't
	// rebuild N×M JSX trees on every poll when nothing actually changed.
	// TanStack Query gives the same `data` reference back on no-op
	// refetches, so the memo deps stay stable.
	const tiles = useMemo<AgentTile[]>(() => {
		return includeDeployments
			? deployments.flatMap((d) =>
					deploymentToTiles(d, envById, {
						isRetrying: inventory.isFetching,
						onRetry: () => {
							void inventory.refetch();
						},
					}),
				)
			: [];
	}, [deployments, includeDeployments, envById, inventory.isFetching, inventory.refetch]);

	// Env ids that are owned by a hosted deployment. The dashboard
	// excludes these from its self-managed grid so a hosted deployment's env
	// — which cloud-api also returns from /v1/agents because
	// the admin endpoint registered it — doesn't double-count as both
	// a hosted tile and a self-managed tile. Lower-cased for the same
	// case-sensitivity defense as `envById`.
	const claimedEnvIds = useMemo(() => {
		if (!includeDeployments) return new Set<string>();
		return claimedEnvIdsFromDeployments(deployments);
	}, [deployments, includeDeployments]);
	const deletionFailures = useMemo(
		() =>
			includeDeployments
				? deployments.filter(
						(deployment) => deploymentFailureProjection(deployment)?.failedVerb === "delete",
					)
				: [],
		[deployments, includeDeployments],
	);

	return {
		inventoryStatus: inventory.status,
		hasExistingDeployments:
			includeDeployments && hasExistingCloudDeployments(inventory.deployments),
		tiles,
		claimedEnvIds,
		deletionFailures,
		isLoading: inventory.status === "loading" && !inventory.hasSnapshot,
		error: inventory.error,
		refetch: inventory.refetch,
	};
}

/**
 * One deployment renders as one hosted agent tile. The selected runtime's stored
 * environment id owns the detail route. Deployment state stays on the detail page;
 * the tile projects only the agent identity and available actions.
 */
export function deploymentToTiles(
	d: HostedDeployment,
	envById: Map<string, Env>,
	statusRetry?: { isRetrying: boolean; onRetry: () => void },
): AgentTile[] {
	if (!isHostedDeploymentVisible(d)) return [];
	const runtime = deploymentRuntime(d);
	const name = deploymentDisplayName(d.resource.spec.name, runtime);
	// The deploy API projects the stable agent identity. The Cloud API env join
	// only decorates the tile and may legitimately lag or be missing.
	const envId = runtimeEnvironmentId(d, runtime);
	const matchedEnv = envId ? envById.get(envId.toLowerCase()) : undefined;
	const routeQuery = {
		source: "on-clawdi",
		[AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY]: d.resource.id,
	};
	const detailHref = envId ? agentSectionHref(envId, "overview", routeQuery) : null;
	const settingsHref = envId ? agentSectionHref(envId, "settings", routeQuery) : undefined;
	const deploymentStatus = deploymentStatusFromResource(d.resource.status);
	const showTileActions =
		deploymentStatus.kind === "stopped" ||
		deploymentStatus.kind === "failed" ||
		deploymentStatus.kind === "unknown" ||
		!envId;
	return [
		{
			id: d.resource.id,
			source: "on-clawdi" as const,
			name,
			avatarUrl: matchedEnv?.avatar_url ?? null,
			sortOrder: matchedEnv?.sort_order ?? null,
			agentType: runtime,
			lastSeenAt: matchedEnv?.last_seen_at ?? null,
			href: detailHref,
			external: false,
			action: showTileActions
				? createElement(HostedDeploymentTileAction, {
						deployment: d,
						remediationHref: settingsHref ? `${settingsHref}#compute-plan-controls` : undefined,
						isRetrying: statusRetry?.isRetrying,
						onRetry: statusRetry?.onRetry,
					})
				: undefined,
			active: isRunningStatus(deploymentStatus),
			env: matchedEnv ?? null,
		},
	];
}
