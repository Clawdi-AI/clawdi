import { workspaceSkillErrorMessage } from "@clawdi/shared/view";
import {
	BillingApiError,
	BillingNetworkError,
	billingErrorDetail,
	billingErrorNormalizer,
	DeploymentConflictError,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import { ApiError, ApiNetworkError, isApiAuthError, normalizeApiError } from "@/lib/api-errors";

export function normalizeWorkspaceSkillError(error: unknown): string {
	if (error instanceof ApiError || error instanceof ApiNetworkError)
		return normalizeApiError(error);
	if (billingErrorNormalizer.isAuthError(error) || error instanceof DeploymentConflictError) {
		return normalizeBillingError(error);
	}
	if (error instanceof BillingNetworkError) {
		return "Couldn't reach Clawdi. Check your connection and try again.";
	}
	const message = workspaceSkillErrorMessage(billingErrorDetail(error)?.code);
	if (message) return message;
	if (error instanceof BillingApiError && error.status === 404) {
		return "This skill or agent is no longer available.";
	}
	return "Couldn't load or update this skill. Try again.";
}

export const workspaceSkillErrorNormalizer = {
	isAuthError: (error: unknown) =>
		isApiAuthError(error) || billingErrorNormalizer.isAuthError(error),
	normalizeError: normalizeWorkspaceSkillError,
};
