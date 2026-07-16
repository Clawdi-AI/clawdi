import type { ComputePlanSlug, DeployRequest } from "@/hosted/billing/contracts";

export type PlanCFundingSource = "stripe" | "wallet";
export type PlanCBillingTermMonths = 1 | 12;

export type PlanCSubscriptionCreateIntent = {
	planSlug: ComputePlanSlug;
	billingTermMonths: PlanCBillingTermMonths;
	fundingSource: PlanCFundingSource;
	deployConfig: DeployRequest;
};

export function planCBillingTermMonths(value: number): PlanCBillingTermMonths | null {
	return value === 1 || value === 12 ? value : null;
}

export function buildPlanCSubscriptionCreateIntent({
	planSlug,
	billingTermMonths,
	fundingSource,
	deployConfig,
}: {
	planSlug: ComputePlanSlug;
	billingTermMonths: number;
	fundingSource: PlanCFundingSource;
	deployConfig: DeployRequest;
}): PlanCSubscriptionCreateIntent | null {
	const supportedTerm = planCBillingTermMonths(billingTermMonths);
	if (!supportedTerm) return null;
	return {
		planSlug,
		billingTermMonths: supportedTerm,
		fundingSource,
		deployConfig,
	};
}
