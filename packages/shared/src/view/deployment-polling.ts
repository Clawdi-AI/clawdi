import type {
	HostedDeployOperation as DeploymentOperation,
	DeploymentRead as HostedDeployment,
} from "../api";
import { type DeploymentStatus, deploymentStatusFromResource } from "./deployment-status";
import { deploymentRuntimeUiWithdrawn, deploymentWebChatIsUsable } from "./runtime-ui-readiness";

export type DeploymentOperationVerb =
	| DeploymentOperation["metadata"]["verb"]
	| "plan_change"
	| "runtime_switch";

export const DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS = 10_000;
export const DEPLOYMENT_TRANSITION_TIMEOUT_MS = 5 * 60_000;
export const DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS = 10 * 60_000;
// A create that claimed a prepared warm instance is usually ready in well under a minute.
export const DEPLOYMENT_WARM_CREATION_TRANSITION_TIMEOUT_MS = 2 * 60_000;
export const DEPLOYMENT_WARM_CREATION_ESCALATION_MS = DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS;
// Escalation uses the same backend operation start time as the timeout.
export const DEPLOYMENT_TRANSITION_ESCALATION_MS = 15 * 60_000;
export const DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS = 60_000;
/**
 * How long after a create completes its first start may still wait for the web chat
 * surface. A running agent whose create finished earlier is not in setup.
 */
export const DEPLOYMENT_SETUP_RUNTIME_UI_GRACE_MS = DEPLOYMENT_TRANSITION_ESCALATION_MS;

export type ProvisioningPath = HostedDeployment["provisioning_path"];

export function deploymentProvisioningPath(deployment: {
	// Older Hosted responses omit the hint; treat them as the standard path.
	provisioning_path?: ProvisioningPath | null;
}): ProvisioningPath {
	return deployment.provisioning_path === "warm" ? "warm" : "standard";
}

export type SettlingTracker = {
	key: string;
	startedAtMs: number;
};

export type SettlingPollState = {
	refetchInterval: number | false;
	timedOut: boolean;
	escalated: boolean;
	tracker: SettlingTracker;
};

export type DeploymentTransitionState = {
	kind: "converging" | "timed_out" | "escalated";
	verb: DeploymentOperationVerb | null;
	startedAtMs: number;
};

export type DeploymentPollingState = {
	refetchInterval: number | false;
	trackers: ReadonlyMap<string, SettlingTracker>;
	transitions: ReadonlyMap<string, DeploymentTransitionState>;
};

export function deploymentAwaitingRuntimeUi(deployment: HostedDeployment): boolean {
	const status = deployment.resource.status;
	return (
		deploymentStatusFromResource(status).kind === "running" &&
		!deploymentRuntimeUiWithdrawn(status) &&
		!deploymentWebChatIsUsable(deployment)
	);
}

/**
 * The first start runs but its web chat surface is not published yet: the create is
 * still pending or finished within the grace window, and the dashboard is not withdrawn.
 */
export function deploymentSetupAwaitingRuntimeUi(
	deployment: HostedDeployment,
	nowMs: number,
): boolean {
	const operation = deployment.accepted_operation;
	if (operation?.metadata.verb !== "create" || !deploymentAwaitingRuntimeUi(deployment)) {
		return false;
	}
	if (!operation.done) return true;
	if (operation.error) return false;
	const completedAtMs = Date.parse(operation.metadata.updateTime ?? "");
	return (
		Number.isFinite(completedAtMs) && nowMs - completedAtMs < DEPLOYMENT_SETUP_RUNTIME_UI_GRACE_MS
	);
}

export function isTransitionalStatus(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "creating":
		case "starting":
		case "stopping":
		case "restarting":
		case "updating":
		case "deleting":
		case "unknown":
			return true;
		case "running":
		case "stopped":
		case "failed":
		case "deleted":
			return false;
		default:
			return exhaustive(status);
	}
}

export function boundedSettlingPollState({
	key,
	startedAtMs,
	tracker,
	nowMs,
	pollIntervalMs,
	timeoutMs,
	fastPollMs = timeoutMs,
	escalationMs = Infinity,
}: {
	key: string;
	startedAtMs: number;
	tracker: SettlingTracker | null;
	nowMs: number;
	pollIntervalMs: number;
	timeoutMs: number;
	/** How long to keep fast polling; defaults to the timeout. */
	fastPollMs?: number;
	escalationMs?: number;
}): SettlingPollState {
	const safeStartedAtMs =
		Number.isFinite(startedAtMs) && startedAtMs <= nowMs ? startedAtMs : nowMs;
	const nextTracker = tracker?.key === key ? tracker : { key, startedAtMs: safeStartedAtMs };
	const ageMs = nowMs - nextTracker.startedAtMs;
	const timedOut = ageMs >= timeoutMs;
	const escalated = timedOut && ageMs >= escalationMs;
	return {
		refetchInterval: ageMs >= fastPollMs ? false : pollIntervalMs,
		timedOut,
		escalated,
		tracker: nextTracker,
	};
}

export function deploymentPollingState(
	deployments: readonly HostedDeployment[] | null | undefined,
	trackers: ReadonlyMap<string, SettlingTracker>,
	nowMs: number,
): DeploymentPollingState {
	const nextTrackers = new Map<string, SettlingTracker>();
	const transitions = new Map<string, DeploymentTransitionState>();
	let refetchInterval: number | false = false;

	for (const deployment of deployments ?? []) {
		if (deployment.accepted_operation?.done && deployment.accepted_operation.error) continue;
		const status = deploymentStatusFromResource(deployment.resource.status);
		const awaitingRuntimeUi = deploymentAwaitingRuntimeUi(deployment);
		if (!isTransitionalStatus(status) && !awaitingRuntimeUi) continue;

		const deploymentId = deployment.resource.id;
		const operation = deployment.accepted_operation;
		const operationStartedAtMs = Date.parse(operation?.metadata.createTime ?? "");
		const thresholds = transitionThresholds(
			awaitingRuntimeUi ? null : (operation?.metadata.verb ?? null),
			deploymentProvisioningPath(deployment),
		);
		const pollState = boundedSettlingPollState({
			key: awaitingRuntimeUi
				? `${deploymentTransitionFallbackKey(deployment)}:runtime-ui`
				: (operation?.name ?? deploymentTransitionFallbackKey(deployment)),
			startedAtMs:
				!awaitingRuntimeUi && Number.isFinite(operationStartedAtMs) ? operationStartedAtMs : nowMs,
			tracker: trackers.get(deploymentId) ?? null,
			nowMs,
			pollIntervalMs: DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
			...thresholds,
		});
		nextTrackers.set(deploymentId, pollState.tracker);
		transitions.set(deploymentId, {
			kind: pollState.escalated ? "escalated" : pollState.timedOut ? "timed_out" : "converging",
			verb: operation?.metadata.verb ?? null,
			startedAtMs: pollState.tracker.startedAtMs,
		});
		if (typeof pollState.refetchInterval === "number") {
			refetchInterval =
				typeof refetchInterval === "number"
					? Math.min(refetchInterval, pollState.refetchInterval)
					: pollState.refetchInterval;
		}
	}
	if (deployments !== null && deployments !== undefined && typeof refetchInterval !== "number") {
		refetchInterval = DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS;
	}

	return { refetchInterval, trackers: nextTrackers, transitions };
}

export function deploymentRefetchInterval(
	deployments: readonly HostedDeployment[] | null | undefined,
	trackers: ReadonlyMap<string, SettlingTracker> = new Map(),
	nowMs = Date.now(),
): number | false {
	return deploymentPollingState(deployments, trackers, nowMs).refetchInterval;
}

function transitionThresholds(
	verb: DeploymentOperation["metadata"]["verb"] | null,
	path: ProvisioningPath,
): { timeoutMs: number; fastPollMs: number; escalationMs: number } {
	if (verb !== "create") {
		return {
			timeoutMs: DEPLOYMENT_TRANSITION_TIMEOUT_MS,
			fastPollMs: DEPLOYMENT_TRANSITION_TIMEOUT_MS,
			escalationMs: DEPLOYMENT_TRANSITION_ESCALATION_MS,
		};
	}
	// A warm create reports a delay early but keeps fast polling through the standard
	// window, because a withdrawn warm claim falls back to standard provisioning.
	return path === "warm"
		? {
				timeoutMs: DEPLOYMENT_WARM_CREATION_TRANSITION_TIMEOUT_MS,
				fastPollMs: DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS,
				escalationMs: DEPLOYMENT_WARM_CREATION_ESCALATION_MS,
			}
		: {
				timeoutMs: DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS,
				fastPollMs: DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS,
				escalationMs: DEPLOYMENT_TRANSITION_ESCALATION_MS,
			};
}

function deploymentTransitionFallbackKey(deployment: HostedDeployment): string {
	return [
		deployment.resource.id,
		deployment.resource.metadata.generation,
		deployment.resource.spec.desired_lifecycle,
	].join(":");
}

function exhaustive(value: never): never {
	throw new Error(`Unhandled deployment status: ${JSON.stringify(value)}`);
}
