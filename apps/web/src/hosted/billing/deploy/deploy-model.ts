import type { BillingOffer, HostedDeployment, Plan } from "@/hosted/billing/contracts";
import {
	COMPUTE_BASIC_SLUG,
	computeFundingMode,
	selectExplicitOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";

export type BasicDeploySelection =
	| {
			mode: "included";
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
				deployment.current_plan_slug,
				deployment.commercial_display?.compute_subscription,
			) !== "included_basic"
		) {
			return false;
		}
		return deployment.compute_slot_occupancy.occupies_slot;
	});
}

export function planCAccessAllowsDeploy(
	canUsePlanCBilling: boolean,
	selection: BasicDeploySelection | "paid",
): boolean {
	return canUsePlanCBilling || (selection !== "paid" && selection.mode === "included");
}

export function resolveBasicDeploySelection({
	basicPlan,
	billingTermMonths,
	includedSlotAvailable = false,
}: {
	basicPlan: Plan | undefined;
	billingTermMonths: number;
	includedSlotAvailable?: boolean;
}): BasicDeploySelection {
	if (!basicPlan) return { mode: "unavailable", reason: "plan_missing" };
	if (includedSlotAvailable) {
		return {
			mode: "included",
			computePlanSlug: COMPUTE_BASIC_SLUG,
			plan: basicPlan,
		};
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
