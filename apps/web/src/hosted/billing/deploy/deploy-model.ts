import { resolveHostedDeployIncludedBasicSelection } from "@clawdi/shared/api";
import type { Plan } from "@/hosted/billing/contracts";
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

export function resolveBasicDeploySelection({
	basicPlan,
	billingTermMonths,
	includedSlotAvailable,
}: {
	basicPlan: Plan | undefined;
	billingTermMonths: number;
	/** `null` means included Basic capacity is unavailable. */
	includedSlotAvailable: boolean | null;
}): BasicDeploySelection {
	return resolveHostedDeployIncludedBasicSelection({
		basicPlan,
		billingTermMonths,
		includedSlotAvailable,
	});
}
