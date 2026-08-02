import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	BillingApiError,
	BillingNetworkError,
	billingErrorDetail,
	DeploymentConflictError,
} from "@/hosted/billing/errors";
import type { DeploymentOperationVerb } from "@/hosted/deployment-status";

const DEFAULT_FAILURE_REASON_MAX_LENGTH = 96;
const PLAN_CHANGE_FAILURE_REASON =
	"The Clawdi service could not confirm the plan change. Your plan was not changed and you were not charged.";
const DEFAULT_SERVICE_FAILURE_REASON = "The Clawdi service could not complete this request.";
const RUNTIME_UNAVAILABLE_REASON =
	"Clawdi is checking the runtime. Open Compute settings for details.";

const CUSTOMER_FAILURE_REASONS_BY_CODE = new Map<string, string>([
	["provider_not_found", "The selected provider is no longer available in your Clawdi account."],
	["invalid_managed_provider_id", "Clawdi AI cannot be combined with a saved provider."],
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
	| { kind: "review_provider"; label: string; requiresWalletTopUp: false }
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
const PROVIDER_CONFIGURATION_CODES = new Set(["provider_not_found", "invalid_managed_provider_id"]);
const RUNTIME_FAILURE_CODES = new Set(["runtime_readiness_timeout"]);
const RUNTIME_FAILURE_PHASES = new Set(["reconcile", "runtime"]);

function isRuntimeStatusFailure(failure: { code?: string; phase?: string | null }): boolean {
	return (
		RUNTIME_FAILURE_CODES.has(failure.code ?? "") || RUNTIME_FAILURE_PHASES.has(failure.phase ?? "")
	);
}

/** Customer-safe copy for declarative agent mutations handled by the deploy API. */
export function deploymentMutationErrorMessage(error: unknown): string {
	if (error instanceof DeploymentConflictError) return error.message;
	if (error instanceof BillingNetworkError) {
		return error.kind === "timeout"
			? "Clawdi couldn’t confirm whether the agent service accepted this change. Check the latest status, then try again."
			: "Clawdi couldn’t reach the agent service. Check your connection, then try again.";
	}
	if (error instanceof BillingApiError) {
		const code = billingErrorDetail(error)?.code;
		if (
			error.status === 403 &&
			error.detail === "The Compute Basic free slot allows only one active deployment."
		) {
			return "Your free Basic compute slot is already in use. Stop that agent or choose paid compute, then try again.";
		}
		if (code === "provider_not_found") {
			return "The selected provider is no longer available in your Clawdi account. Choose Clawdi AI or save the provider again, then retry.";
		}
		if (code === "invalid_managed_provider_id") {
			return "Clawdi AI can’t be combined with a saved provider. Choose Clawdi AI alone or choose a saved provider, then retry.";
		}
		if (error.status === 401) {
			return "Your session has expired. Sign in again before changing this agent.";
		}
		if (error.status === 403) {
			return "Your Clawdi account can’t change this agent. Ask the agent owner to update it.";
		}
		if (error.status === 404) {
			return "This agent is no longer available. Return to Agents and refresh the list.";
		}
		if (error.status >= 500 || error.status === 429) {
			return "The Clawdi agent service couldn’t complete this change. Check the latest status, then try again in a moment.";
		}
	}
	return "Clawdi couldn’t apply this agent change. Check the latest status and settings, then try again.";
}

/** Stable product name for every operation verb; never render the wire value. */
export function deploymentOperationLabel(verb: DeploymentOperationVerb | null): string {
	switch (verb) {
		case "create":
			return "Agent setup";
		case "start":
			return "Agent startup";
		case "stop":
			return "Agent stop";
		case "restart":
			return "Agent restart";
		case "reset_runtime_ui_access":
			return "Runtime UI access reset";
		case "update":
			return "Agent update";
		case "runtime_switch":
			return "Agent software change";
		case "rename":
			return "Agent rename";
		case "delete":
			return "Agent deletion";
		case "plan_change":
			return "Plan change";
		case null:
			return "Agent action";
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
	const statusFailure =
		deployment?.resource.status?.summary_state === "failed"
			? deployment.resource.status.failure
			: null;
	if (failure.failedVerb === null && statusFailure && isRuntimeStatusFailure(statusFailure)) {
		return {
			...failure,
			title: "Agent temporarily unavailable",
			description: RUNTIME_UNAVAILABLE_REASON,
			remediation: { kind: "none", label: null, requiresWalletTopUp: false },
		};
	}
	if (failure.failedVerb === null && statusFailure?.phase === "plan_change") {
		return {
			...failure,
			title: "Plan change failed",
			description: "Get a fresh quote and confirm the price before trying again.",
			remediation: {
				kind: "review_plan_change",
				label: "Get fresh quote",
				requiresWalletTopUp,
			},
		};
	}
	if (PROVIDER_CONFIGURATION_CODES.has(failure.code)) {
		return {
			...failure,
			title: "Provider configuration failed",
			description:
				"The current provider settings could not start this agent. Fix or switch the provider, then save the agent settings.",
			remediation: {
				kind: "review_provider",
				label: "Fix provider",
				requiresWalletTopUp: false,
			},
		};
	}

	switch (failure.failedVerb) {
		case "create":
		case "start":
			return {
				...failure,
				title: `${operationLabel} failed`,
				description: requiresWalletTopUp
					? `Top up your Wallet, then retry ${operationName}.`
					: `The Clawdi service could not finish ${operationName}. Restart the agent to try again.`,
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
					? "The Clawdi service could not restart the agent. Top up your Wallet, then try again."
					: "The Clawdi service could not restart the agent. Review the reason below, then try again.",
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
				description:
					"The Clawdi service did not delete the agent. Review the reason, then try again.",
				remediation: {
					kind: "retry_delete",
					label: "Retry delete",
					requiresWalletTopUp: false,
				},
			};
		case "stop":
		case "update":
		case "reset_runtime_ui_access":
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
	if (isRuntimeStatusFailure(failure)) return RUNTIME_UNAVAILABLE_REASON;
	return CUSTOMER_FAILURE_REASONS_BY_CODE.get(failure.code ?? "") ?? DEFAULT_SERVICE_FAILURE_REASON;
}

/** One tab-agnostic failure view backed by the authoritative failed snapshot. */
export function deploymentFailureProjection(
	deployment: HostedDeployment | null | undefined,
): DeploymentFailureProjection | null {
	if (!deployment) return null;
	const status = deployment.resource.status;
	const operation = deployment.accepted_operation;
	const operationFailed = operation?.done === true && operation.error != null;
	const operationFailure = operationFailed ? operation.error?.details[0] : null;
	const statusFailure =
		status?.summary_state === "failed" && status.failure ? status.failure : null;
	const failure = operationFailure ?? statusFailure;
	if (!failure && !operationFailed) return null;
	// A completed operation can remain attached to later status snapshots. Its
	// verb only names a failure when that operation itself terminated with an
	// error; otherwise a later runtime/reconcile failure is a separate event.
	const failedVerb = operationFailed ? operation.metadata.verb : null;
	const reason = failure
		? deploymentFailureReason({ failure }, failedVerb)
		: DEFAULT_SERVICE_FAILURE_REASON;
	if (!reason) return null;
	return {
		reason,
		failedVerb,
		retryable: failure?.retryable ?? null,
		code: failure?.code ?? "operation_failed",
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
