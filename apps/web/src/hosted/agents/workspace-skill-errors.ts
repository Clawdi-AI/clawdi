import {
	BillingApiError,
	BillingNetworkError,
	billingErrorDetail,
	billingErrorNormalizer,
	DeploymentConflictError,
	normalizeBillingError,
} from "@/hosted/billing/errors";

export function normalizeWorkspaceSkillError(error: unknown): string {
	if (billingErrorNormalizer.isAuthError(error) || error instanceof DeploymentConflictError) {
		return normalizeBillingError(error);
	}
	if (error instanceof BillingNetworkError) {
		return "Couldn't reach Clawdi. Check your connection and try again.";
	}
	switch (billingErrorDetail(error)?.code) {
		case "workspace_skill_source_invalid":
			return "Couldn't find a valid Skill at this GitHub path. Check the repository and try again.";
		case "workspace_skill_source_unavailable":
			return "GitHub is temporarily unavailable. Please try again.";
		case "workspace_skill_source_conflict":
			return "A Skill with this name is installed from another repository. Uninstall it first.";
		case "workspace_skill_reserved":
			return "This Skill is built in and can't be changed.";
		case "workspace_skills_capability_unavailable":
			return "Skill installation will be available when your Agent is ready and up to date.";
	}
	if (error instanceof BillingApiError && error.status === 404) {
		return "This Skill or Agent is no longer available.";
	}
	return "Couldn't load or update this Skill. Please try again.";
}

export const workspaceSkillErrorNormalizer = {
	isAuthError: billingErrorNormalizer.isAuthError,
	normalizeError: normalizeWorkspaceSkillError,
};
