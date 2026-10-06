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
	switch (billingErrorDetail(error)?.code) {
		case "workspace_skill_source_invalid":
			return "Couldn't find a valid skill at this GitHub path. Check the repository and try again.";
		case "workspace_skill_source_unavailable":
			return "GitHub is temporarily unavailable. Try again.";
		case "workspace_skill_source_conflict":
			return "A skill with this name is installed from another repository. Uninstall it first.";
		case "workspace_skill_reserved":
			return "This skill is built in and can't be changed.";
		case "workspace_skills_capability_unavailable":
			return "Skill installation will be available when your agent is ready and up to date.";
	}
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
