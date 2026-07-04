export const KNOWN_DEPLOYMENT_STATUSES = [
	"pending",
	"provisioning",
	"starting",
	"running",
	"ready",
	"stopped",
	"failed",
	"error",
	"stopping",
	"restarting",
	"deleting",
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

export function parseDeploymentStatus(raw: string | null | undefined): DeploymentStatus {
	const value = raw?.trim() ?? "";
	const normalized = value.toLowerCase();
	if (KNOWN_STATUS_SET.has(normalized)) {
		const kind = normalized as KnownDeploymentStatus;
		return { kind, raw: kind, known: true };
	}
	return { kind: "unknown", raw: value || "unknown", known: false };
}

export function deploymentStatusLabel(status: DeploymentStatus): string {
	switch (status.kind) {
		case "pending":
			return "Pending";
		case "provisioning":
			return "Provisioning";
		case "starting":
			return "Starting";
		case "running":
			return "Running";
		case "ready":
			return "Ready";
		case "stopped":
			return "Stopped";
		case "failed":
		case "error":
			return "Failed";
		case "stopping":
			return "Stopping";
		case "restarting":
			return "Restarting";
		case "deleting":
			return "Deleting";
		case "unknown":
			return titleCaseStatus(status.raw);
		default:
			return exhaustive(status);
	}
}

export function deploymentStatusTone(status: DeploymentStatus): DeploymentStatusTone {
	switch (status.kind) {
		case "running":
		case "ready":
			return "success";
		case "failed":
		case "error":
			return "destructive";
		case "stopped":
			return "neutral";
		case "pending":
		case "provisioning":
		case "starting":
		case "restarting":
			return "info";
		case "stopping":
		case "deleting":
		case "unknown":
			return "warning";
		default:
			return exhaustive(status);
	}
}

export function isRunningStatus(status: DeploymentStatus): boolean {
	return status.kind === "running" || status.kind === "ready";
}

export function isTerminalStatus(status: DeploymentStatus): boolean {
	return (
		status.kind === "running" ||
		status.kind === "ready" ||
		status.kind === "stopped" ||
		status.kind === "failed" ||
		status.kind === "error"
	);
}

export function isTransitionalStatus(status: DeploymentStatus): boolean {
	return !isTerminalStatus(status);
}

export function canStart(status: DeploymentStatus): boolean {
	return status.kind === "stopped" || status.kind === "failed" || status.kind === "error";
}

export function canStop(status: DeploymentStatus): boolean {
	return isRunningStatus(status);
}

export function canRestart(status: DeploymentStatus): boolean {
	return isRunningStatus(status) || status.kind === "failed" || status.kind === "error";
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
