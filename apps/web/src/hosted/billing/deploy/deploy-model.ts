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
			reason: "plan_missing" | "offers_missing" | "inventory_unavailable";
	  };

export function usesActiveIncludedBasicSlot(
	deployments: HostedDeployment[] | undefined,
): boolean | null {
	let occupancyUnavailable = false;
	for (const deployment of deployments ?? []) {
		if (
			computeFundingMode(
				deployment.current_plan_slug,
				deployment.commercial_display?.compute_subscription,
			) !== "included_basic"
		) {
			continue;
		}
		const occupancy = deployment.compute_slot_occupancy;
		if (occupancy === null) {
			occupancyUnavailable = true;
			continue;
		}
		if (occupancy.occupies_slot) return true;
	}
	return occupancyUnavailable ? null : false;
}

export function resolveBasicDeploySelection({
	basicPlan,
	billingTermMonths,
	includedSlotAvailable,
}: {
	basicPlan: Plan | undefined;
	billingTermMonths: number;
	/** `null` means deployment inventory or included-slot occupancy is unavailable. */
	includedSlotAvailable: boolean | null;
}): BasicDeploySelection {
	if (!basicPlan) return { mode: "unavailable", reason: "plan_missing" };
	if (includedSlotAvailable === null) {
		return { mode: "unavailable", reason: "inventory_unavailable" };
	}
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
