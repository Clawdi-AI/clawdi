import type { HostedDeployment } from "@/hosted/billing/contracts";
import type { DeploymentOperationVerb } from "@/hosted/deployment-status";

const DEFAULT_FAILURE_REASON_MAX_LENGTH = 96;
const INTERNAL_OPERATION_REFERENCE_RE =
	/\s*(?:operation\s+id\s*:\s*)?operations\/[A-Za-z0-9._~-]+[.!]?/gi;
const INTERNAL_DEPLOYMENT_REFERENCE_RE =
	/\s*(?:deployment\s+id\s*:\s*)?hdep_[A-Za-z0-9._~-]+[.!]?/gi;
const INTERNAL_UUID_REFERENCE_RE =
	/\s*(?:(?:agent|environment|deployment)\s+id\s*:\s*)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.!]?/gi;

function userFacingFailureReason(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(INTERNAL_OPERATION_REFERENCE_RE, "")
		.replace(INTERNAL_DEPLOYMENT_REFERENCE_RE, "")
		.replace(INTERNAL_UUID_REFERENCE_RE, "")
		.replace(/\s+([,.!?])/g, "$1")
		.trim();
}

export type DeploymentFailureProjection = {
	reason: string;
	failedVerb: DeploymentOperationVerb | null;
	retryable: boolean | null;
	code: string;
};

export type DeploymentFailureRemediation =
	| { kind: "restart"; label: string; requiresWalletTopUp: boolean }
	| { kind: "review_plan_change"; label: string; requiresWalletTopUp: boolean }
	| { kind: "retry_delete"; label: string; requiresWalletTopUp: false }
	| { kind: "none"; label: null; requiresWalletTopUp: boolean };

export type DeploymentFailurePresentation = DeploymentFailureProjection & {
	title: string;
	description: string;
	remediation: DeploymentFailureRemediation;
};

const WALLET_FUNDING_REASON_RE =
	/\b(?:top[ -]?up|insufficient(?: wallet)? (?:balance|funds?)|wallet (?:balance|funds?).*(?:low|short|empty|exhausted|depleted)|refund debt)\b/i;
const WALLET_FUNDING_CODES = new Set([
	"insufficient_balance",
	"insufficient_wallet_balance",
	"open_refund_debt",
]);

/** Stable product name for every operation verb; never render the wire value. */
export function deploymentOperationLabel(verb: DeploymentOperationVerb | null): string {
	switch (verb) {
		case "create":
			return "Agent setup";
		case "start":
			return "Agent startup";
		case "stop":
			return "Compute stop";
		case "restart":
			return "Compute restart";
		case "update":
			return "Agent update";
		case "rename":
			return "Agent rename";
		case "delete":
			return "Agent deletion";
		case "plan_change":
			return "Plan change";
		case null:
			return "Deployment operation";
	}
}

function deploymentFailureNeedsWalletTopUp(failure: DeploymentFailureProjection): boolean {
	return WALLET_FUNDING_CODES.has(failure.code) || WALLET_FUNDING_REASON_RE.test(failure.reason);
}

/** Shared honest copy/action decision for detail, status, and tile surfaces. */
export function deploymentFailurePresentation(
	deployment: HostedDeployment | null | undefined,
): DeploymentFailurePresentation | null {
	const failure = deploymentFailureProjection(deployment);
	if (!failure) return null;
	const operationLabel = deploymentOperationLabel(failure.failedVerb);
	const operationName = operationLabel.toLocaleLowerCase();
	const requiresWalletTopUp = deploymentFailureNeedsWalletTopUp(failure);

	switch (failure.failedVerb) {
		case "create":
		case "start":
			return {
				...failure,
				title: `${operationLabel} failed`,
				description: requiresWalletTopUp
					? `Top up your Wallet, then retry ${operationName}.`
					: `Restart the compute to retry ${operationName}.`,
				remediation: {
					kind: "restart",
					label: "Retry startup",
					requiresWalletTopUp,
				},
			};
		case "restart":
			return {
				...failure,
				title: `${operationLabel} failed`,
				description: requiresWalletTopUp
					? "Top up your Wallet, then retry the compute restart."
					: "Retry the compute restart after reviewing the reason below.",
				remediation: {
					kind: "restart",
					label: "Retry restart",
					requiresWalletTopUp,
				},
			};
		case "plan_change":
			return {
				...failure,
				title: `${operationLabel} failed`,
				description: requiresWalletTopUp
					? "Open Compute settings to top up your Wallet, request a fresh quote, and confirm the price before retrying."
					: "Open Compute settings to request a fresh quote and confirm the price before retrying.",
				remediation: {
					kind: "review_plan_change",
					label: "Review plan",
					requiresWalletTopUp,
				},
			};
		case "delete":
			return {
				...failure,
				title: `${operationLabel} failed`,
				description: "The deployment was not deleted. Review the reason, then retry deletion.",
				remediation: {
					kind: "retry_delete",
					label: "Retry delete",
					requiresWalletTopUp: false,
				},
			};
		case "stop":
		case "update":
		case "rename":
		case null:
			return {
				...failure,
				title: `${operationLabel} failed`,
				description: `Review the reason below. There is no safe one-click retry for this ${operationName} failure.`,
				remediation: { kind: "none", label: null, requiresWalletTopUp },
			};
	}
}

export function deploymentFailureReason(
	input: {
		failure?: {
			title: string;
			conditionMessage: string;
			detail?: string;
			phase?: string | null;
		} | null;
	} | null,
): string | null {
	const failure = input?.failure;
	const candidates =
		failure?.phase === "plan_change"
			? [failure.detail, failure.title, failure.conditionMessage]
			: [failure?.title, failure?.conditionMessage];
	for (const candidate of candidates) {
		// Backend reasons are concatenated from conditions, so they arrive with
		// ragged padding. Collapse it once here — every label and tooltip is
		// derived from this value.
		const reason = userFacingFailureReason(candidate ?? "");
		if (reason) return reason;
	}
	return null;
}

/** One tab-agnostic failure view backed by the authoritative failed snapshot. */
export function deploymentFailureProjection(
	deployment: HostedDeployment | null | undefined,
): DeploymentFailureProjection | null {
	if (!deployment) return null;
	const status = deployment.resource.status;
	if (status === null || status.summary_state !== "failed") return null;
	const failure = status.failure;
	const reason = deploymentFailureReason(status);
	if (!failure || !reason) return null;
	return {
		reason,
		failedVerb: deployment.accepted_operation?.metadata.verb ?? null,
		retryable: failure.retryable ?? null,
		code: failure.code,
	};
}

export function compactDeploymentFailureReason(
	reason: string,
	maxLength = DEFAULT_FAILURE_REASON_MAX_LENGTH,
): string {
	const compact = reason.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	if (maxLength <= 3) return compact.slice(0, maxLength);
	return `${compact.slice(0, maxLength - 3)}...`;
}
