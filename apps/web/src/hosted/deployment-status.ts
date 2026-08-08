import type {
	DeploymentOperation,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";

export const KNOWN_DEPLOYMENT_STATUSES = [
	"creating",
	"starting",
	"running",
	"stopping",
	"stopped",
	"restarting",
	"updating",
	"failed",
	"deleting",
	"deleted",
] as const;

export type KnownDeploymentStatus = (typeof KNOWN_DEPLOYMENT_STATUSES)[number];
export type DeploymentStatusTone = "success" | "warning" | "destructive" | "info" | "neutral";

type KnownDeploymentStatusModel = {
	kind: KnownDeploymentStatus;
	raw: KnownDeploymentStatus;
	known: true;
};

export type UnknownDeploymentStatus =
	| {
			kind: "unknown";
			raw: string;
			known: false;
			reason: "unrecognized";
	  }
	| {
			kind: "unknown";
			raw: null;
			known: false;
			reason: "status_unavailable";
	  };

export type DeploymentStatus = KnownDeploymentStatusModel | UnknownDeploymentStatus;
export type DeploymentStatusPresentation = {
	status: DeploymentStatus;
	label: string;
	tone: DeploymentStatusTone;
};
// `plan_change` is a projected failure phase; `runtime_switch` remains a live
// legacy wire value while the hosted main rollout converges.
export type DeploymentOperationVerb =
	| DeploymentOperation["metadata"]["verb"]
	| "plan_change"
	| "runtime_switch";

export const DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS = 10_000;
export const DEPLOYMENT_TRANSITION_TIMEOUT_MS = 5 * 60_000;
export const DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS = 10 * 60_000;
// The backend controller keeps recovering stalled generations on its own
// (60s scan, `clawdi_v2_a3_stalled_generation_seconds` in clawdi-hosted
// backend/app/v2/hosted/controller_scheduling.py). Escalation waits well
// past that recovery cadence and past the "taking longer than expected"
// window before offering cancellation, anchored on the same backend-reported
// operation create time.
export const DEPLOYMENT_TRANSITION_ESCALATION_MS = 15 * 60_000;
export const DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS = 60_000;

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

const KNOWN_STATUS_SET = new Set<string>(KNOWN_DEPLOYMENT_STATUSES);
const LEGACY_STATUS_ALIASES = new Map<string, KnownDeploymentStatus>([["ready", "running"]]);

export function parseDeploymentStatus(raw: string): DeploymentStatus {
	const value = raw.trim();
	const normalized = value.toLowerCase();
	const alias = LEGACY_STATUS_ALIASES.get(normalized);
	if (alias) {
		return { kind: alias, raw: alias, known: true };
	}
	if (KNOWN_STATUS_SET.has(normalized)) {
		const kind = normalized as KnownDeploymentStatus;
		return { kind, raw: kind, known: true };
	}
	return { kind: "unknown", raw: value, known: false, reason: "unrecognized" };
}

/**
 * A missing declarative projection is different from an unrecognized future
 * status value. Keep that distinction explicit instead of feeding null through
 * the string parser or fabricating a lifecycle state.
 */
export function deploymentStatusFromResource(
	status: HostedDeploymentStatus | null,
): DeploymentStatus {
	if (status === null) {
		return { kind: "unknown", raw: null, known: false, reason: "status_unavailable" };
	}
	return parseDeploymentStatus(status.summary_state);
}

export function deploymentStatusLabel(status: DeploymentStatus): string {
	switch (status.kind) {
		case "creating":
			return "Starting";
		case "starting":
			return "Starting";
		case "running":
			return "Running";
		case "stopping":
			return "Stopping";
		case "stopped":
			return "Stopped";
		case "restarting":
			return "Restarting";
		case "updating":
			return "Updating";
		case "failed":
			return "Failed";
		case "deleting":
			return "Deleting";
		case "deleted":
			return "Deleted";
		case "unknown":
			return status.reason === "status_unavailable"
				? "Status unavailable"
				: titleCaseStatus(status.raw);
		default:
			return exhaustive(status);
	}
}

export function deploymentStatusTone(status: DeploymentStatus): DeploymentStatusTone {
	switch (status.kind) {
		case "running":
		case "restarting":
		case "updating":
			return "success";
		case "failed":
			return "destructive";
		case "stopped":
		case "deleted":
			return "neutral";
		case "creating":
		case "starting":
		case "stopping":
		case "deleting":
			return "info";
		case "unknown":
			return "warning";
		default:
			return exhaustive(status);
	}
}

function hasCurrentRuntimeHealthDegradation(status: HostedDeploymentStatus): boolean {
	return (
		status.summary_state === "running" &&
		status.conditions.some(
			(condition) =>
				condition.type === "Degraded" &&
				condition.status === "True" &&
				condition.reason === "RuntimeHealthDegraded" &&
				condition.observedGeneration === status.observedGeneration,
		)
	);
}

export function deploymentRuntimeStatusPresentation(
	resourceStatus: HostedDeploymentStatus | null,
): DeploymentStatusPresentation {
	const status = deploymentStatusFromResource(resourceStatus);
	if (resourceStatus && hasCurrentRuntimeHealthDegradation(resourceStatus)) {
		return { status, label: "Temporarily unavailable", tone: "warning" };
	}
	return {
		status,
		label: deploymentStatusLabel(status),
		tone: deploymentStatusTone(status),
	};
}

export function isRunningStatus(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "running":
		case "restarting":
		case "updating":
			return true;
		case "creating":
		case "starting":
		case "stopping":
		case "stopped":
		case "failed":
		case "deleting":
		case "deleted":
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
}

/**
 * Stopping a deployment removes its cloud-agent projection while preserving
 * the deployment row. Do not query that absent projection until Start moves
 * the deployment back into a recoverable lifecycle state.
 */
export function canQueryDeploymentProjection(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "stopped":
		case "deleted":
			return false;
		case "creating":
		case "starting":
		case "running":
		case "stopping":
		case "restarting":
		case "updating":
		case "failed":
		case "deleting":
			return true;
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
}

export function isTerminalStatus(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "running":
		case "stopped":
		case "failed":
		case "deleted":
			return true;
		case "creating":
		case "starting":
		case "stopping":
		case "restarting":
		case "updating":
		case "deleting":
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
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

export function canStart(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "stopped":
		case "failed":
			return true;
		case "creating":
		case "starting":
		case "running":
		case "stopping":
		case "restarting":
		case "updating":
		case "deleting":
		case "deleted":
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
}

export function canStop(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "running":
		case "starting":
			return true;
		case "creating":
		case "stopping":
		case "stopped":
		case "restarting":
		case "updating":
		case "failed":
		case "deleting":
		case "deleted":
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
}

export function canRestart(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "running":
		case "failed":
			return true;
		case "creating":
		case "starting":
		case "stopping":
		case "stopped":
		case "restarting":
		case "updating":
		case "deleting":
		case "deleted":
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
}

export function canDelete(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "creating":
		case "starting":
		case "running":
		case "stopping":
		case "stopped":
		case "restarting":
		case "updating":
		case "failed":
			return true;
		case "deleting":
		case "deleted":
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
}

/**
 * Whether the in-flight accepted operation can accept a cancel request. Mirrors
 * the cancel acceptance side in clawdi-hosted operation_cancellation.py: only
 * operations that are still running and are not backend-managed image cohort
 * operations are cancellable.
 */
export function canCancelOperation(operation: DeploymentOperation | null | undefined): boolean {
	if (!operation || operation.done) return false;
	return (
		operation.metadata.verb !== "migrate_image" && operation.metadata.verb !== "rollback_image"
	);
}

/** Shared started-at/timeout primitive for lifecycle and runtime-UI convergence. */
export function boundedSettlingPollState({
	key,
	startedAtMs,
	tracker,
	nowMs,
	pollIntervalMs,
	timeoutMs,
	escalationMs = Infinity,
}: {
	key: string;
	startedAtMs: number;
	tracker: SettlingTracker | null;
	nowMs: number;
	pollIntervalMs: number;
	timeoutMs: number;
	escalationMs?: number;
}): SettlingPollState {
	const safeStartedAtMs =
		Number.isFinite(startedAtMs) && startedAtMs <= nowMs ? startedAtMs : nowMs;
	const nextTracker = tracker?.key === key ? tracker : { key, startedAtMs: safeStartedAtMs };
	const ageMs = nowMs - nextTracker.startedAtMs;
	const timedOut = ageMs >= timeoutMs;
	const escalated = timedOut && ageMs >= escalationMs;
	return {
		refetchInterval: timedOut ? false : pollIntervalMs,
		timedOut,
		escalated,
		tracker: nextTracker,
	};
}

export function shouldPollDeployments(
	items: readonly { status: string | null | undefined }[] | null | undefined,
): boolean {
	return (items ?? []).some((deployment) => {
		const status: DeploymentStatus =
			deployment.status === null || deployment.status === undefined
				? {
						kind: "unknown",
						raw: null,
						known: false,
						reason: "status_unavailable",
					}
				: parseDeploymentStatus(deployment.status);
		return isTransitionalStatus(status);
	});
}

/**
 * Fast-poll each accepted lifecycle operation only during its bounded
 * convergence window, then fall back to the foreground reconciliation
 * interval so delayed transitions still surface without a background
 * polling loop.
 */
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
		if (!isTransitionalStatus(status)) continue;

		const deploymentId = deployment.resource.id;
		const operation = deployment.accepted_operation;
		const operationStartedAtMs = Date.parse(operation?.metadata.createTime ?? "");
		const pollState = boundedSettlingPollState({
			key: operation?.name ?? deploymentTransitionFallbackKey(deployment),
			startedAtMs: Number.isFinite(operationStartedAtMs) ? operationStartedAtMs : nowMs,
			tracker: trackers.get(deploymentId) ?? null,
			nowMs,
			pollIntervalMs: DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
			timeoutMs:
				operation?.metadata.verb === "create"
					? DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS
					: DEPLOYMENT_TRANSITION_TIMEOUT_MS,
			escalationMs: DEPLOYMENT_TRANSITION_ESCALATION_MS,
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

function deploymentTransitionFallbackKey(deployment: HostedDeployment): string {
	return [
		deployment.resource.id,
		deployment.resource.metadata.generation,
		deployment.resource.spec.desired_lifecycle,
	].join(":");
}

function titleCaseStatus(raw: string): string {
	const cleaned = raw.trim();
	if (!cleaned) return "Unknown";
	return cleaned
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
		.join(" ");
}

function exhaustive(value: never): never {
	throw new Error(`Unhandled deployment status: ${JSON.stringify(value)}`);
}
