import {
	resolveHostedDeployIncludedBasicSelection,
	usesHostedDeployIncludedBasicSlot,
} from "@clawdi/shared/api";
import type { HostedDeployment, Plan } from "@/hosted/billing/contracts";
import type { COMPUTE_BASIC_SLUG } from "@/hosted/billing/subscription/subscription-utils";

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
			offer: NonNullable<Plan["offers"]>[number];
			plan: Plan;
	  }
	| {
			mode: "unavailable";
			reason: "plan_missing" | "offers_missing" | "inventory_unavailable";
	  };

export function usesActiveIncludedBasicSlot(
	deployments: HostedDeployment[] | undefined,
): boolean | null {
	return usesHostedDeployIncludedBasicSlot(deployments);
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
	return resolveHostedDeployIncludedBasicSelection({
		basicPlan,
		billingTermMonths,
		includedSlotAvailable,
	});
}
