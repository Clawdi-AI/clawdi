import { DEPLOYMENT_SUBSCRIPTION_REQUIRED_REASON } from "@clawdi/shared/view";

export {
	compactDeploymentFailureReason,
	type DeploymentFailurePresentation,
	type DeploymentFailureProjection,
	type DeploymentFailureRemediation,
	deploymentFailurePresentation,
	deploymentFailureProjection,
	deploymentFailureReason,
	deploymentOperationLabel,
} from "@clawdi/shared/view";

import {
	BillingApiError,
	BillingNetworkError,
	billingErrorDetail,
	DeploymentConflictError,
} from "@/hosted/billing/errors";

/** Customer-safe copy for declarative agent mutations handled by the deploy API. */
export function deploymentMutationErrorMessage(error: unknown): string {
	const cause = error instanceof DeploymentConflictError ? error.cause : error;
	if (billingErrorDetail(cause)?.code === "funding_revoked_after_accept") {
		return DEPLOYMENT_SUBSCRIPTION_REQUIRED_REASON;
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
