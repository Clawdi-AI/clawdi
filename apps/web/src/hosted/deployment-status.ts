export const KNOWN_DEPLOYMENT_STATUSES = [
	"creating",
	"starting",
	"running",
	"stopped",
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

export type UnknownDeploymentStatus = {
	kind: "unknown";
	raw: string;
	known: false;
};

export type DeploymentStatus = KnownDeploymentStatusModel | UnknownDeploymentStatus;

const KNOWN_STATUS_SET = new Set<string>(KNOWN_DEPLOYMENT_STATUSES);
const LEGACY_STATUS_ALIASES = new Map<string, KnownDeploymentStatus>([["ready", "running"]]);

export function parseDeploymentStatus(raw: string | null | undefined): DeploymentStatus {
	const value = raw?.trim() ?? "";
	const normalized = value.toLowerCase();
	const alias = LEGACY_STATUS_ALIASES.get(normalized);
	if (alias) {
		return { kind: alias, raw: alias, known: true };
	}
	if (KNOWN_STATUS_SET.has(normalized)) {
		const kind = normalized as KnownDeploymentStatus;
		return { kind, raw: kind, known: true };
	}
	return { kind: "unknown", raw: value || "unknown", known: false };
}

export function deploymentStatusLabel(status: DeploymentStatus): string {
	switch (status.kind) {
		case "creating":
			return "Provisioning";
		case "starting":
			return "Starting";
		case "running":
			return "Running";
		case "stopped":
			return "Stopped";
		case "failed":
			return "Failed";
		case "deleting":
			return "Deleting";
		case "deleted":
			return "Deleted";
		case "unknown":
			return titleCaseStatus(status.raw);
		default:
			return exhaustive(status);
	}
}

export function deploymentStatusTone(status: DeploymentStatus): DeploymentStatusTone {
	switch (status.kind) {
		case "running":
			return "success";
		case "failed":
			return "destructive";
		case "stopped":
		case "deleted":
			return "neutral";
		case "creating":
		case "starting":
		case "deleting":
			return "info";
		case "unknown":
			return "warning";
		default:
			return exhaustive(status);
	}
}

export function isRunningStatus(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "running":
			return true;
		case "creating":
		case "starting":
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
 * Mirror of the deploy-API's `NO_BACKING_INFRA_FAILURE_REASONS`
 * (backend/app/v2/hosted/slot_occupancy.py). A deployment that failed for one
 * of these reasons has no k8s resources, so it holds no compute slot.
 */
const NO_BACKING_INFRA_FAILURE_REASONS = new Set([
	"backend_status=not_found",
	"creation_interrupted",
]);

function failureReasonIndicatesNoBackingInfra(failureReason: string | null | undefined): boolean {
	const normalized = failureReason?.trim().replace(/\s+/g, " ") ?? "";
	if (!normalized) return false;
	if (NO_BACKING_INFRA_FAILURE_REASONS.has(normalized)) return true;
	return normalized.startsWith("backend_status=not_found;");
}

/**
 * The single source of truth for "this deployment consumes a compute slot",
 * kept byte-for-byte in step with the deploy-API's `slot_occupancy.py`. A
 * `failed` deployment keeps its slot unless its failure reason proves the
 * backing infra is gone — a still-running pod costs us either way.
 */
export function occupiesComputeSlot(deployment: {
	status: string | null | undefined;
	failure_reason?: string | null;
	stopped_at?: string | null;
	deleted_at?: string | null;
}): boolean {
	if (deployment.deleted_at) return false;
	if (deployment.stopped_at) return false;
	const status = parseDeploymentStatus(deployment.status);
	if (status.kind === "deleted" || status.kind === "stopped") return false;
	if (status.kind === "failed" && failureReasonIndicatesNoBackingInfra(deployment.failure_reason)) {
		return false;
	}
	return true;
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

export function canRestart(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "running":
		case "starting":
		case "failed":
			return true;
		case "creating":
		case "stopped":
		case "deleting":
		case "deleted":
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
}

export function shouldPollDeployments(
	items: readonly { status: string | null | undefined }[] | null | undefined,
): boolean {
	return (items ?? []).some((deployment) =>
		isTransitionalStatus(parseDeploymentStatus(deployment.status)),
	);
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
