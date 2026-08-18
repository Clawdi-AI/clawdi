import type { HostedDeployment } from "@/hosted/billing/contracts";
import { isNetworkError } from "@/hosted/billing/errors";
import {
	type DeploymentStatus,
	deploymentStatusFromResource,
	isRunningStatus,
	isTransitionalStatus,
} from "@/hosted/deployment-status";
import { observedCloudProjectionId } from "@/hosted/runtimes";
import { isApiNotFoundError } from "@/lib/api-errors";

export type HostedInventoryStatus = "resolved" | "loading" | "error" | "unavailable";

export type HostedInventoryResolution = {
	status: HostedInventoryStatus;
	/**
	 * The last successful membership snapshot. Deleted deployments retain any
	 * projected agent claim until the projection is cleaned up.
	 * `null` means membership has never resolved; an empty array is authoritative.
	 */
	deployments: HostedDeployment[] | null;
	hasSnapshot: boolean;
	error: Error | null;
};

export type HostedInventoryQueryState = {
	enabled: boolean;
	configured: boolean;
	data: HostedDeployment[] | undefined;
	error: Error | null;
	isPending: boolean;
};

export class HostedInventoryUnavailableError extends Error {
	constructor() {
		super("Clawdi Cloud inventory is unavailable from this dashboard.");
		this.name = "HostedInventoryUnavailableError";
	}
}

/** Deleted deployments retain a projected agent claim during asynchronous cleanup. */
export function isHostedDeploymentMember(deployment: HostedDeployment): boolean {
	return (
		deploymentStatusFromResource(deployment.resource.status).kind !== "deleted" ||
		observedCloudProjectionId(deployment) !== undefined
	);
}

/** Pending or authoritatively accepted deletion dismisses the agent during cleanup. */
export function isHostedDeploymentVisible(deployment: HostedDeployment): boolean {
	const status = deploymentStatusFromResource(deployment.resource.status);
	const acceptedOperation = deployment.accepted_operation;
	return (
		status.kind !== "deleting" &&
		status.kind !== "deleted" &&
		!(acceptedOperation?.metadata.verb === "delete" && !acceptedOperation.done) &&
		deployment.compute_slot_occupancy?.reason !== "delete_accepted"
	);
}

export function hostedDeploymentMembers(
	deployments: readonly HostedDeployment[],
): HostedDeployment[] {
	return deployments.filter(isHostedDeploymentMember);
}

/** One claimed-id set shared by list deduplication and ownership chrome. */
export function claimedEnvIdsFromDeployments(
	deployments: readonly HostedDeployment[],
): Set<string> {
	const environmentIds = new Set<string>();
	for (const deployment of deployments) {
		if (!isHostedDeploymentMember(deployment)) continue;
		environmentIds.add(deployment.agent_id.toLowerCase());
	}
	return environmentIds;
}

export type AgentDeploymentMatch = {
	deployment: HostedDeployment;
	runtime: string | null;
};

/** Resolve Hosted membership from the authoritative Agent identity only. */
export function resolveAgentDeployment(
	deployments: readonly HostedDeployment[],
	agentId: string,
): AgentDeploymentMatch | null {
	const members = deployments.filter(isHostedDeploymentVisible);
	const target = agentId.toLowerCase();
	const deployment = members.find((candidate) => candidate.agent_id.toLowerCase() === target);
	return deployment ? { deployment, runtime: deployment.resource.spec.runtime } : null;
}

/**
 * Convert the deployments query into the one inventory state consumed by all
 * dashboard surfaces. Successful empty data is distinct from an unresolved
 * source, and a failed refresh retains the last successful snapshot.
 */
export function resolveHostedInventory({
	enabled,
	configured,
	data,
	error,
	isPending,
}: HostedInventoryQueryState): HostedInventoryResolution {
	if (!enabled) {
		return { status: "resolved", deployments: [], hasSnapshot: true, error: null };
	}

	if (!configured) {
		return {
			status: "unavailable",
			deployments: null,
			hasSnapshot: false,
			error: new HostedInventoryUnavailableError(),
		};
	}

	const deployments = data === undefined ? null : hostedDeploymentMembers(data);
	// TanStack Query retains the last successful data when a later refetch
	// fails. That snapshot remains the authoritative membership view; the
	// refresh error must not turn a resolved list (including an empty list)
	// back into a blocking inventory state.
	if (deployments !== null) {
		return { status: "resolved", deployments, hasSnapshot: true, error: null };
	}
	if (error) {
		return {
			status: isNetworkError(error) ? "unavailable" : "error",
			deployments: null,
			hasSnapshot: false,
			error,
		};
	}

	return {
		status: isPending ? "loading" : "unavailable",
		deployments: null,
		hasSnapshot: false,
		error: isPending ? null : new HostedInventoryUnavailableError(),
	};
}

export type HostedProjectionResolution<T> =
	| { status: "resolved"; data: T; error: null }
	| { status: "loading"; data: null; error: null }
	| { status: "missing"; data: null; error: Error }
	| { status: "error"; data: null; error: Error }
	| { status: "unavailable"; data: null; error: null };

export function resolveHostedAgentProjection<T>({
	enabled,
	data,
	error,
	isPending,
}: {
	enabled: boolean;
	data: T | undefined;
	error: Error | null;
	isPending: boolean;
}): HostedProjectionResolution<T> {
	if (!enabled) return { status: "unavailable", data: null, error: null };
	if (error) {
		return isApiNotFoundError(error)
			? { status: "missing", data: null, error }
			: { status: "error", data: null, error };
	}
	if (data !== undefined) return { status: "resolved", data, error: null };
	if (isPending) return { status: "loading", data: null, error: null };
	return { status: "unavailable", data: null, error: null };
}

const PROJECTION_MISSING_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const;

/** Bounded, foreground-only reconciliation cadence for a lagging projection. */
export function missingProjectionRefetchInterval(
	error: Error | null,
	deploymentStatus: DeploymentStatus,
	failureCount: number,
): number | false {
	if (!error || !isApiNotFoundError(error)) return false;
	if (!deploymentStatus.known) return false;
	if (!isRunningStatus(deploymentStatus) && !isTransitionalStatus(deploymentStatus)) return false;
	const index = Math.min(Math.max(failureCount - 1, 0), PROJECTION_MISSING_BACKOFF_MS.length - 1);
	return PROJECTION_MISSING_BACKOFF_MS[index] ?? false;
}

/** The same authoritative gate is shared by header and inline Runtime UI actions. */
export function canOpenHostedRuntimeUi(
	deploymentStatus: DeploymentStatus,
	consoleUrl: string | null | undefined,
): boolean {
	return Boolean(consoleUrl) && isRunningStatus(deploymentStatus);
}
