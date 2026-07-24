"use client";

import type { components } from "@clawdi/shared/api";
import { createElement, useMemo } from "react";
import { agentDisplayName } from "@/components/dashboard/agent-label";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { type DaemonStatusVisual, daemonStatusVisual } from "@/components/dashboard/daemon-status";
import { statusTextVariants } from "@/components/ui/status-badge";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { computeDunningTileStatus } from "@/hosted/billing/components/compute-dunning.logic";
import type { HostedDeployment, HostedDeploymentStatus } from "@/hosted/billing/contracts";
import { hasExistingCloudDeployments } from "@/hosted/cloud-deployment-management";
import {
	compactDeploymentFailureReason,
	deploymentFailureReason,
} from "@/hosted/deployment-failure";
import {
	type DeploymentStatus,
	type DeploymentStatusTone,
	deploymentStatusLabel,
	deploymentStatusTone,
	isRunningStatus,
	parseDeploymentStatus,
} from "@/hosted/deployment-status";
import {
	claimedEnvIdsFromDeployments,
	isHostedDeploymentMember,
} from "@/hosted/hosted-agent-resolution";
import { HostedDeploymentTileAction } from "@/hosted/hosted-deployment-tile-action";
import { deploymentRuntime, runtimeDisplayName, runtimeEnvironmentId } from "@/hosted/runtimes";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";
import { AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY, agentSectionHref } from "@/lib/agent-routes";

type Env = components["schemas"]["AgentResponse"];
type DeploymentStatusInput = {
	failure?: HostedDeploymentStatus["failure"];
	summary_state: string;
};

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
): HostedRuntimeStatusView {
	const compute = parseDeploymentStatus(deployment.summary_state);
	const computeLabel = deploymentStatusLabel(compute);
	const computeTone = deploymentStatusTone(compute);
	const sync = env === undefined ? null : daemonStatusVisual(env, "on-clawdi");
	const computeIsRunning = isRunningStatus(compute);
	const failureReason = compute.kind === "failed" ? deploymentFailureReason(deployment) : null;
	let secondary: HostedRuntimeStatusView["secondary"] = null;
	if (failureReason) {
		secondary = {
			kind: "failure_reason",
			label: `Failure: ${compactDeploymentFailureReason(failureReason)}`,
			tooltip: failureReason,
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
 * `DaemonStatusBadge` that powers
 * self-managed tiles' "Synced 2m ago" label fires on hosted tiles too
 * — hosted runtimes register cloud-api envs with their own daemon, so
 * the data is the same shape; only the "Clawdi" pill distinguishes
 * hosted in the UI.
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
		return includeDeployments ? deployments.flatMap((d) => deploymentToTiles(d, envById)) : [];
	}, [deployments, includeDeployments, envById]);

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

	return {
		inventoryStatus: inventory.status,
		hasExistingDeployments:
			includeDeployments && hasExistingCloudDeployments(inventory.deployments),
		tiles,
		claimedEnvIds,
		isLoading: inventory.status === "loading" && !inventory.hasSnapshot,
		error: inventory.error,
		refetch: inventory.refetch,
	};
}

/**
 * One deployment renders as one hosted agent tile. The selected runtime's stored
 * environment id owns the detail route. A matching projection decorates the tile
 * with daemon sync state and presentation metadata.
 */
export function deploymentToTiles(d: HostedDeployment, envById: Map<string, Env>): AgentTile[] {
	if (!isHostedDeploymentMember(d)) return [];
	const runtime = deploymentRuntime(d);
	const slug = deploymentDisplayName(d.resource.spec.name, runtime);
	// Hosted deployments don't use last_seen_at; status is the freshness signal
	// The deploy API projects the stable agent identity. The cloud-api env
	// join only decorates the tile and may legitimately lag or be missing.
	const envId = runtimeEnvironmentId(d, runtime);
	const matchedEnv = envId ? envById.get(envId.toLowerCase()) : undefined;
	const routeQuery = {
		source: "on-clawdi",
		[AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY]: d.resource.id,
	};
	const detailHref = envId ? agentSectionHref(envId, "overview", routeQuery) : null;
	const settingsHref = envId ? agentSectionHref(envId, "settings", routeQuery) : undefined;
	const name = matchedEnv
		? deploymentDisplayName(agentDisplayName(matchedEnv), runtime)
		: runtimeDisplayName(runtime);
	const contextLabel = slug !== name ? slug : null;
	const runtimeStatus = hostedRuntimeStatusView(d.resource.status, matchedEnv ?? null);
	const showTileActions = runtimeStatus.compute.kind === "stopped" || !envId;
	const dunningStatus = computeDunningTileStatus(d);
	const failureReasonStatus =
		runtimeStatus.secondary?.kind === "failure_reason" ? runtimeStatus.secondary : null;
	return [
		{
			id: d.resource.id,
			source: "on-clawdi" as const,
			name,
			avatarUrl: matchedEnv?.avatar_url ?? null,
			sortOrder: matchedEnv?.sort_order ?? null,
			agentType: runtime,
			contextLabel,
			statusLabel: runtimeStatus.primary.label,
			lastSeenAt: matchedEnv?.last_seen_at ?? null,
			href: detailHref,
			external: false,
			action: showTileActions
				? createElement(HostedDeploymentTileAction, { deployment: d })
				: undefined,
			manageHref: settingsHref,
			active: runtimeStatus.active,
			statusDot: {
				label: runtimeStatus.primary.label,
				tone: runtimeStatus.primary.tone,
			},
			secondaryStatus: failureReasonStatus
				? {
						label: failureReasonStatus.label,
						title: failureReasonStatus.tooltip,
						textClass: failureReasonStatus.textClass,
					}
				: dunningStatus
					? dunningStatus
					: runtimeStatus.secondary
						? {
								label: runtimeStatus.secondary.label,
								title: runtimeStatus.secondary.tooltip,
								textClass: runtimeStatus.secondary.textClass,
							}
						: null,
			env: matchedEnv ?? null,
		},
	];
}
