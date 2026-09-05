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
	"Clawdi is checking this Agent. Open Agent settings for details.";
const SUBSCRIPTION_REQUIRED_REASON =
	"This agent needs an active subscription to start. Open Agent settings and choose a subscription. Your saved data is kept.";

export type DeploymentFailureProjection = {
	reason: string;
	failedVerb: DeploymentOperationVerb | null;
	retryable: boolean | null;
	code: string;
};

export type DeploymentFailureRemediation =
	| { kind: "restart"; label: string }
	| { kind: "review_plan_change"; label: string }
	| { kind: "retry_delete"; label: string }
	| { kind: "none"; label: null };

export type DeploymentFailurePresentation = DeploymentFailureProjection & {
	title: string;
	description: string;
	status: {
		kind: "failed" | "runtime_unavailable" | "cancelled";
		label: "Failed" | "Temporarily unavailable" | "Cancelled";
		tone: "destructive" | "warning" | "neutral";
	};
	remediation: DeploymentFailureRemediation;
};

const RUNTIME_FAILURE_CODES = new Set(["runtime_readiness_timeout"]);
const FAILED_STATUS = { kind: "failed", label: "Failed", tone: "destructive" } as const;
const RUNTIME_UNAVAILABLE_STATUS = {
	kind: "runtime_unavailable",
	label: "Temporarily unavailable",
	tone: "warning",
} as const;
const CANCELLED_STATUS = { kind: "cancelled", label: "Cancelled", tone: "neutral" } as const;

function isRuntimeStatusFailure(failure: { code?: string }): boolean {
	return RUNTIME_FAILURE_CODES.has(failure.code ?? "");
}

/** Customer-safe copy for declarative agent mutations handled by the deploy API. */
export function deploymentMutationErrorMessage(error: unknown): string {
	const cause = error instanceof DeploymentConflictError ? error.cause : error;
	if (billingErrorDetail(cause)?.code === "funding_revoked_after_accept") {
		return SUBSCRIPTION_REQUIRED_REASON;
	}
	if (error instanceof DeploymentConflictError) return error.message;
	if (error instanceof BillingNetworkError) {
		return error.kind === "timeout"
			? "Clawdi couldn’t confirm whether the agent service accepted this change. Check the latest status, then try again."
			: "Clawdi couldn’t reach the agent service. Check your connection, then try again.";
	}
	if (error instanceof BillingApiError) {
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

/**
 * Copy for a cancellation request rejected by the deploy API. Cancellation is
 * accepted while an operation is still in flight; the backend races the
 * operation itself, so a completed change or a reused key get their own honest
 * messages instead of the generic mutation copy.
 */
export function operationCancelErrorMessage(error: unknown): string {
	if (error instanceof DeploymentConflictError) return error.message;
	const detail = error instanceof BillingApiError ? billingErrorDetail(error) : null;
	if (detail?.code === "operation_cancelled") {
		return "This change already finished before cancellation could be applied.";
	}
	if (detail?.code === "idempotency_key_reused") {
		return "This cancellation was already requested. Check the latest status, then try again.";
	}
	return deploymentMutationErrorMessage(error);
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
			return "Dashboard access reset";
		case "update":
		case "migrate_runtime_context":
		case "migrate_image":
		case "rollback_image":
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

/** Shared honest copy/action decision for detail, status, and tile surfaces. */
export function deploymentFailurePresentation(
	deployment: HostedDeployment | null | undefined,
): DeploymentFailurePresentation | null {
	const failure = deploymentFailureProjection(deployment);
	if (!failure) return null;
	const operationLabel = deploymentOperationLabel(failure.failedVerb);
	const operationName = operationLabel.toLocaleLowerCase();
	if (failure.code === "funding_revoked_after_accept") {
		return {
			...failure,
			title: "Subscription required",
			description: SUBSCRIPTION_REQUIRED_REASON,
			status: FAILED_STATUS,
			remediation: { kind: "none", label: null },
		};
	}
	const statusFailure =
		deployment?.resource.status?.summary_state === "failed"
			? deployment.resource.status.failure
			: null;
	// Specific customer-actionable classes must win over a broad controller
	// phase such as reconcile. A phase alone cannot prove a runtime-health issue.
	if (failure.failedVerb === null && statusFailure?.phase === "plan_change") {
		return {
			...failure,
			title: "Plan change failed",
			description: "Get a fresh quote and confirm the price before trying again.",
			status: FAILED_STATUS,
			remediation: {
				kind: "review_plan_change",
				label: "Get fresh quote",
			},
		};
	}
	if (failure.failedVerb === null && statusFailure && isRuntimeStatusFailure(statusFailure)) {
		return {
			...failure,
			title: "Temporarily unavailable",
			description: RUNTIME_UNAVAILABLE_REASON,
			status: RUNTIME_UNAVAILABLE_STATUS,
			remediation: { kind: "none", label: null },
		};
	}
	// A user-initiated cancellation is not a failure: the operation was stopped
	// deliberately and the backend committed a compensating desired state. Say
	// so instead of offering the failure's retry actions.
	if (failure.code === "operation_cancelled") {
		return {
			...failure,
			title: `${operationLabel} cancelled`,
			description: `The in-progress ${operationName} was stopped before it completed. Check the latest status and try again when you’re ready.`,
			status: CANCELLED_STATUS,
			remediation: { kind: "none", label: null },
		};
	}

	switch (failure.failedVerb) {
		case "create":
		case "start":
			return {
				...failure,
				title: `${operationLabel} failed`,
				description: `The Clawdi service could not finish ${operationName}. Restart the agent to try again.`,
				status: FAILED_STATUS,
				remediation: {
					kind: "restart",
					label: "Retry startup",
				},
			};
		case "restart":
			return {
				...failure,
				title: `${operationLabel} failed`,
				description:
					"The Clawdi service could not restart the agent. Review the reason below, then try again.",
				status: FAILED_STATUS,
				remediation: {
					kind: "restart",
					label: "Retry restart",
				},
			};
		case "plan_change":
			return {
				...failure,
				title: `${operationLabel} failed`,
				description: "Get a fresh quote and confirm the price before trying again.",
				status: FAILED_STATUS,
				remediation: {
					kind: "review_plan_change",
					label: "Get fresh quote",
				},
			};
		case "delete":
			return {
				...failure,
				title: `${operationLabel} failed`,
				description:
					"The Clawdi service did not delete the agent. Review the reason, then try again.",
				status: FAILED_STATUS,
				remediation: {
					kind: "retry_delete",
					label: "Retry delete",
				},
			};
		case "stop":
		case "update":
		case "migrate_runtime_context":
		case "reset_runtime_ui_access":
		case "runtime_switch":
		case "migrate_image":
		case "rollback_image":
		case "rename":
		case null:
			return {
				...failure,
				title: `${operationLabel} failed`,
				description:
					"Clawdi could not complete this action. Check the current Agent status. Contact support if the issue persists.",
				status: FAILED_STATUS,
				remediation: { kind: "none", label: null },
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
	if (failure.code === "funding_revoked_after_accept") return SUBSCRIPTION_REQUIRED_REASON;

	// Failure title/detail/conditionMessage are free-form backend strings. Even
	// after removing identifiers they can contain exception names or service
	// vocabulary, so none of them are customer copy. Only structured classes
	// that the client explicitly recognizes may select a specific message.
	if (failedVerb === "plan_change" || failure.phase === "plan_change") {
		return PLAN_CHANGE_FAILURE_REASON;
	}
	return isRuntimeStatusFailure(failure)
		? RUNTIME_UNAVAILABLE_REASON
		: DEFAULT_SERVICE_FAILURE_REASON;
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
