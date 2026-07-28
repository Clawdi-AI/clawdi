import type { HostedDeployment } from "@/hosted/billing/contracts";
import { isNetworkError } from "@/hosted/billing/errors";
import {
	type DeploymentStatus,
	deploymentStatusFromResource,
	isRunningStatus,
	isTransitionalStatus,
} from "@/hosted/deployment-status";
import { runtimeEnvironmentId } from "@/hosted/runtimes";
import { isApiNotFoundError } from "@/lib/api-errors";

export type HostedInventoryStatus = "resolved" | "loading" | "error" | "unavailable";

export type HostedInventoryResolution = {
	status: HostedInventoryStatus;
	/**
	 * The last successful membership snapshot, with deleted deployments removed.
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

/** Deleted deployments stop owning an agent as soon as the deploy API says so. */
export function isHostedDeploymentMember(deployment: HostedDeployment): boolean {
	return deploymentStatusFromResource(deployment.resource.status).kind !== "deleted";
}

/** Accepted deletion dismisses the agent while its deployment remains observable for cleanup. */
export function isHostedDeploymentVisible(deployment: HostedDeployment): boolean {
	const status = deploymentStatusFromResource(deployment.resource.status);
	return (
		status.kind !== "deleting" &&
		status.kind !== "deleted" &&
		deployment.accepted_operation?.metadata.verb !== "delete"
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
		const environmentId = runtimeEnvironmentId(deployment);
		if (environmentId) environmentIds.add(environmentId.toLowerCase());
	}
	return environmentIds;
}

export type AgentDeploymentMatch = {
	deployment: HostedDeployment;
	runtime: string | null;
};

export type AgentDeploymentResolution = {
	match: AgentDeploymentMatch | null;
	ambiguousMatches: AgentDeploymentMatch[];
	matchKind: "deployment-id" | "environment-id" | "selector-retained" | "bound-retained" | null;
};

/** Resolve detail membership from deployment identity, never from projection presence. */
export function resolveAgentDeployment(
	deployments: readonly HostedDeployment[],
	environmentId: string,
	deploymentSelector?: string | null,
): AgentDeploymentResolution {
	const members = deployments.filter(isHostedDeploymentVisible);
	const target = environmentId.toLowerCase();
	const direct = members.find((deployment) => deployment.resource.id.toLowerCase() === target);
	if (direct) {
		return {
			match: { deployment: direct, runtime: null },
			ambiguousMatches: [],
			matchKind: "deployment-id",
		};
	}
	const selectedDeployment = deploymentSelector
		? members.find(
				(deployment) => deployment.resource.id.toLowerCase() === deploymentSelector.toLowerCase(),
			)
		: undefined;

	const matches: AgentDeploymentMatch[] = [];
	for (const deployment of members) {
		const runtime = deployment.resource.spec.runtime;
		if (runtimeEnvironmentId(deployment, runtime)?.toLowerCase() === target) {
			matches.push({ deployment, runtime });
		}
	}

	if (deploymentSelector) {
		const selector = deploymentSelector.toLowerCase();
		const selected = matches.find((item) => item.deployment.resource.id.toLowerCase() === selector);
		if (selected) {
			return { match: selected, ambiguousMatches: [], matchKind: "environment-id" };
		}
	}

	if (matches.length === 1) {
		return { match: matches[0], ambiguousMatches: [], matchKind: "environment-id" };
	}
	// Stop removes the runtime projection (and therefore its environment-id
	// mapping) but leaves the deployment itself. Tile/detail links carry this
	// selector specifically so the retained deployment remains addressable.
	if (matches.length === 0 && selectedDeployment) {
		return {
			match: { deployment: selectedDeployment, runtime: null },
			ambiguousMatches: [],
			matchKind: "selector-retained",
		};
	}
	return { match: null, ambiguousMatches: matches, matchKind: null };
}

/**
 * Once a live projection proves which deployment owns a route, a stale `d=`
 * may not retarget that same mounted URL if the projection disappears. Keep
 * the proven deployment when it is still an inventory member; otherwise fail
 * closed. A new selector creates a new request identity in the calling hook.
 */
export function retainBoundAgentDeployment(
	deployments: readonly HostedDeployment[],
	resolution: AgentDeploymentResolution,
	boundDeploymentId: string | null,
): AgentDeploymentResolution {
	if (!boundDeploymentId || resolution.ambiguousMatches.length > 0) return resolution;
	const normalizedBoundId = boundDeploymentId.toLowerCase();
	if (resolution.match?.deployment.resource.id.toLowerCase() === normalizedBoundId)
		return resolution;
	const bound = deployments
		.filter(isHostedDeploymentVisible)
		.find((deployment) => deployment.resource.id.toLowerCase() === normalizedBoundId);
	return bound
		? {
				match: { deployment: bound, runtime: null },
				ambiguousMatches: [],
				matchKind: "bound-retained",
			}
		: { match: null, ambiguousMatches: [], matchKind: null };
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
	if (error) {
		return {
			status: isNetworkError(error) ? "unavailable" : "error",
			deployments,
			hasSnapshot: deployments !== null,
			error,
		};
	}

	if (deployments !== null) {
		return { status: "resolved", deployments, hasSnapshot: true, error: null };
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
