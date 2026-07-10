import type { DeleteDeploymentResult } from "@/hosted/billing/contracts";
import { formatShortDate } from "@/lib/format";

type DeleteDeploymentToastTone = "success" | "warning";

export type DeleteDeploymentToastDecision = {
	tone: DeleteDeploymentToastTone;
	title: string;
	description?: string;
};

export function deleteDeploymentToastDecision(
	result: DeleteDeploymentResult,
): DeleteDeploymentToastDecision {
	if (result.subscription_cancel_failed) {
		return {
			tone: "warning",
			title: "Check billing settings",
			description:
				"The compute was deleted, but we couldn't schedule subscription cancellation. Check billing settings before the next renewal.",
		};
	}

	if (result.subscription?.cancel_at_period_end) {
		const periodEnd = formatShortDate(result.subscription.current_period_end);
		const periodText = periodEnd === "—" ? "through the current period" : `until ${periodEnd}`;
		return {
			tone: "success",
			title: "Agent deleted",
			description: `The subscription stays active ${periodText} and won't renew.`,
		};
	}

	return { tone: "success", title: "Agent deleted" };
}
