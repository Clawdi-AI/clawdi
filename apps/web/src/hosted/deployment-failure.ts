import type { HostedDeployment } from "@/hosted/billing/contracts";
import type { DeploymentOperationVerb } from "@/hosted/deployment-status";

const DEFAULT_FAILURE_REASON_MAX_LENGTH = 96;
const PLAN_CHANGE_FAILURE_REASON =
	"The Clawdi service could not confirm the plan change. Your plan was not changed and you were not charged.";
const DEFAULT_SERVICE_FAILURE_REASON = "The Clawdi service could not complete this request.";

const CUSTOMER_FAILURE_REASONS_BY_CODE = new Map<string, string>([
	[
		"insufficient_balance",
		"Your Wallet balance was too low for the Clawdi service to complete this request.",
	],
	[
		"insufficient_wallet_balance",
		"Your Wallet balance was too low for the Clawdi service to complete this request.",
	],
	[
		"open_refund_debt",
		"Your Wallet has an unsettled refund balance, so the Clawdi service could not complete this request.",
	],
]);

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
		case "runtime_switch":
			return "Runtime switch";
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
	return WALLET_FUNDING_CODES.has(failure.code);
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
					? "Top up your Wallet, then get a fresh quote and confirm the price before trying again."
					: "Get a fresh quote and confirm the price before trying again.",
				remediation: {
					kind: "review_plan_change",
					label: "Get fresh quote",
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
		case "runtime_switch":
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
			code?: string;
		} | null;
	} | null,
	failedVerb: DeploymentOperationVerb | null = null,
): string | null {
	const failure = input?.failure;
	if (!failure) return null;

	// Failure title/detail/conditionMessage are free-form backend strings. Even
	// after removing identifiers they can contain exception names or service
	// vocabulary, so none of them are customer copy. Only structured classes
	// that the client explicitly recognizes may select a specific message.
	if (failedVerb === "plan_change" || failure.phase === "plan_change") {
		return PLAN_CHANGE_FAILURE_REASON;
	}
	return CUSTOMER_FAILURE_REASONS_BY_CODE.get(failure.code ?? "") ?? DEFAULT_SERVICE_FAILURE_REASON;
}

/** One tab-agnostic failure view backed by the authoritative failed snapshot. */
export function deploymentFailureProjection(
	deployment: HostedDeployment | null | undefined,
): DeploymentFailureProjection | null {
	if (!deployment) return null;
	const status = deployment.resource.status;
	if (status === null || status.summary_state !== "failed") return null;
	const failure = status.failure;
	if (!failure) return null;
	const failedVerb = deployment.accepted_operation?.metadata.verb ?? null;
	const reason = deploymentFailureReason(status, failedVerb);
	if (!reason) return null;
	return {
		reason,
		failedVerb,
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
