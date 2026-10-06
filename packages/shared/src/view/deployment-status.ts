import type { DeployComponents } from "../api";

type HostedDeploymentStatus = DeployComponents["schemas"]["HostedDeploymentStatus"];
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
			return "Status unavailable";
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

export function hasCurrentRuntimeHealthDegradation(status: HostedDeploymentStatus): boolean {
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

function exhaustive(value: never): never {
	throw new Error(`Unhandled deployment status: ${JSON.stringify(value)}`);
}
