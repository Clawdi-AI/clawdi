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

export type UnknownDeploymentStatus = {
	kind: "unknown";
	raw: string;
	known: false;
};

export type DeploymentStatus = KnownDeploymentStatusModel | UnknownDeploymentStatus;

export const DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS = 10_000;
export const DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS = 75_000;

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
			return titleCaseStatus(status.raw);
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
	return status.kind !== "deleting" && status.kind !== "deleted";
}

export function shouldPollDeployments(
	items: readonly { status: string | null | undefined }[] | null | undefined,
): boolean {
	return (items ?? []).some((deployment) =>
		isTransitionalStatus(parseDeploymentStatus(deployment.status)),
	);
}

/**
 * Transitional deployments converge quickly; stable snapshots still reconcile
 * periodically so changes made in another tab or control plane become visible.
 */
export function deploymentRefetchInterval(
	items: readonly { status: string | null | undefined }[] | null | undefined,
): number {
	return shouldPollDeployments(items)
		? DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS
		: DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS;
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
