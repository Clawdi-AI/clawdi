import type { BillingOffer, HostedDeployment, Plan } from "@/hosted/billing/contracts";
import {
	COMPUTE_BASIC_SLUG,
	computeFundingMode,
	selectExplicitOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";
import { occupiesComputeSlot } from "@/hosted/deployment-status";

export type BasicDeploySelection =
	| {
			mode: "direct";
			computePlanSlug: typeof COMPUTE_BASIC_SLUG;
			plan: Plan;
	  }
	| {
			mode: "checkout";
			billingTermMonths: number;
			computePlanSlug: typeof COMPUTE_BASIC_SLUG;
			offer: BillingOffer;
			plan: Plan;
	  }
	| {
			mode: "unavailable";
			reason: "plan_missing" | "offers_missing";
	  };

export function usesActiveIncludedBasicSlot(deployments: HostedDeployment[] | undefined): boolean {
	return (deployments ?? []).some((deployment) => {
		if (
			computeFundingMode(
				deployment.config_info?.compute_plan_slug,
				deployment.compute_subscription,
			) !== "included_basic"
		) {
			return false;
		}
		return occupiesComputeSlot(deployment);
	});
}

export function resolveBasicDeploySelection({
	includedSlotUsed,
	basicPlan,
	billingTermMonths,
}: {
	includedSlotUsed: boolean;
	basicPlan: Plan | undefined;
	billingTermMonths: number;
}): BasicDeploySelection {
	if (!basicPlan) return { mode: "unavailable", reason: "plan_missing" };
	if (!includedSlotUsed) {
		return { mode: "direct", computePlanSlug: COMPUTE_BASIC_SLUG, plan: basicPlan };
	}

	const selection = selectExplicitOfferForTerm(basicPlan, billingTermMonths);
	if (!selection) return { mode: "unavailable", reason: "offers_missing" };
	return {
		mode: "checkout",
		billingTermMonths: selection.billingTermMonths,
		computePlanSlug: COMPUTE_BASIC_SLUG,
		offer: selection.offer,
		plan: basicPlan,
	};
}
