"use client";
import { deploymentToTiles } from "@clawdi/shared/view";

export {
	deploymentToTiles,
	type HostedRuntimeStatusView,
	hostedRuntimeStatusView,
} from "@clawdi/shared/view";

import type { components } from "@clawdi/shared/api";
import type { AgentTile } from "@clawdi/shared/view";
import { useMemo } from "react";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { hasExistingCloudDeployments } from "@/hosted/cloud-deployment-management";
import { claimedEnvIdsFromDeployments } from "@/hosted/hosted-agent-resolution";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";

type Env = components["schemas"]["AgentResponse"];

const EMPTY_DEPLOYMENTS: HostedDeployment[] = [];

/**
 * Bridges hosted deploy API `Deployment` records to the unified `AgentTile`
 * shape rendered by `AgentsCard`. Hosted-side projection lives here so
 * `AgentsCard` itself never imports from `@/hosted/*`.
 *
 * `cloudEnvs` is the cloud-api Agent list the parent already fetches for the
 * self-managed grid. Hosted tiles join it by the deployment's authoritative
 * `agent_id` for avatar and sort metadata without making that projection
 * authoritative for deployment state.
 */
export function useHostedAgentTiles({
	cloudEnvs,
	includeDeployments = true,
	eventStreamActive = false,
}: {
	cloudEnvs: Env[];
	includeDeployments?: boolean;
	eventStreamActive?: boolean;
}) {
	const inventory = useHostedDeploymentInventory({
		enabled: includeDeployments,
		eventStreamActive,
	});
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
		isFetching: inventory.isFetching,
		isLoading: inventory.status === "loading" && !inventory.hasSnapshot,
		error: inventory.error,
		refetch: inventory.refetch,
	};
}

/**
 * One deployment renders as one Hosted Agent tile. The authoritative Agent UUID
 * owns the detail route; deployment identity stays attached to compute actions.
 */
