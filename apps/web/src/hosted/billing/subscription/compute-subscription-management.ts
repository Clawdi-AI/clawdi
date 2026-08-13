import type { ComputePlanSlug, HostedDeployment } from "@/hosted/billing/contracts";
import { deploymentStatusFromResource, isRunningStatus } from "@/hosted/deployment-status";
import {
	activePlanChangeOperationName,
	performanceUpgradeUnavailableReason,
} from "./plan-change.logic";
import {
	type PlanChangeTarget,
	planChangeBillingTerm,
	planChangeTargetUnavailableReason,
} from "./plan-change-controller";
import {
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeFundingSource,
} from "./subscription-utils";

export type ComputeSubscriptionEntitlement = {
	deploymentId: string | null | undefined;
	planSlug: string | null | undefined;
	fundingSource: "stripe" | "wallet" | null | undefined;
	priceCents: number | null | undefined;
	billingTermMonths: number;
	status: string;
	paymentState: string;
	cancelAtPeriodEnd: boolean;
	recoveryAction: string | null | undefined;
	pendingPlanSlug: string | null | undefined;
	isOrphan?: boolean;
};

export type ComputeSubscriptionManagementResult =
	| { action: "hidden"; target: PlanChangeTarget | null; unavailableReason: null }
	| { action: "disabled"; target: null; unavailableReason: string }
	| { action: "enabled"; target: PlanChangeTarget; unavailableReason: null };

export const COMPUTE_PLANS_UNAVAILABLE_REASON =
	"Retry loading compute plans to manage this subscription.";

const PROJECTION_UNAVAILABLE_REASON =
	"Subscription changes will be available after this agent’s compute details finish syncing.";

function isComputePlanSlug(value: string | null | undefined): value is ComputePlanSlug {
	return value === COMPUTE_BASIC_SLUG || value === COMPUTE_PERFORMANCE_SLUG;
}

function blocksManagement(entitlement: ComputeSubscriptionEntitlement): boolean {
	return (
		entitlement.cancelAtPeriodEnd ||
		(entitlement.status !== "active" && entitlement.status !== "past_due") ||
		entitlement.paymentState !== "ok" ||
		entitlement.recoveryAction != null ||
		entitlement.pendingPlanSlug != null
	);
}

function projectedIncludedBasicEntitlement(
	deployment: HostedDeployment,
): ComputeSubscriptionEntitlement | null {
	const subscription = deployment.commercial_display?.compute_subscription;
	if (
		deployment.current_plan_slug !== COMPUTE_BASIC_SLUG ||
		!subscription ||
		computeFundingSource(deployment.current_plan_slug, subscription) !== "included_basic"
	) {
		return null;
	}
	return {
		deploymentId: deployment.resource.id,
		planSlug: deployment.current_plan_slug,
		fundingSource: subscription.funding_source,
		priceCents: subscription.price_cents,
		billingTermMonths: subscription.billing_term_months,
		status: subscription.status,
		paymentState: subscription.payment_state,
		cancelAtPeriodEnd: subscription.cancel_at_period_end,
		recoveryAction: subscription.recovery_action,
		pendingPlanSlug: subscription.pending_plan_slug,
	};
}

export function computeSubscriptionManagement({
	entitlement: initialEntitlement,
	deployment,
	canCreateCloudAgents,
	plansLoading,
	plansError,
	performancePlanAvailable,
}: {
	entitlement: ComputeSubscriptionEntitlement;
	deployment?: HostedDeployment | null;
	canCreateCloudAgents: boolean;
	plansLoading: boolean;
	plansError: boolean;
	performancePlanAvailable: boolean;
}): ComputeSubscriptionManagementResult {
	if (initialEntitlement.isOrphan) {
		return { action: "hidden", target: null, unavailableReason: null };
	}
	const deploymentId = initialEntitlement.deploymentId?.trim();
	const planSlug = isComputePlanSlug(initialEntitlement.planSlug)
		? initialEntitlement.planSlug
		: null;
	if (!deploymentId || !planSlug) {
		return { action: "hidden", target: null, unavailableReason: null };
	}

	const fundingSource = computeFundingSource(initialEntitlement.planSlug, {
		funding_source: initialEntitlement.fundingSource,
		price_cents: initialEntitlement.priceCents,
	});
	const includedBasic = fundingSource === "included_basic";
	const paid = fundingSource === "stripe" || fundingSource === "wallet";
	if (!includedBasic && !paid) {
		return { action: "hidden", target: null, unavailableReason: null };
	}
	const projectedOperationName = deployment ? activePlanChangeOperationName(deployment) : null;
	if (projectedOperationName === null && blocksManagement(initialEntitlement)) {
		return { action: "hidden", target: null, unavailableReason: null };
	}

	let entitlement = initialEntitlement;
	let terminalFallback = false;
	if (includedBasic) {
		if (!deployment || deployment.resource.id.toLowerCase() !== deploymentId.toLowerCase()) {
			return { action: "disabled", target: null, unavailableReason: PROJECTION_UNAVAILABLE_REASON };
		}
		terminalFallback =
			deployment.commercial_display?.latest_funding_fact?.fact_kind === "funding_revoked";
		const projectedEntitlement = projectedIncludedBasicEntitlement(deployment);
		if (!projectedEntitlement) {
			return { action: "disabled", target: null, unavailableReason: PROJECTION_UNAVAILABLE_REASON };
		}
		entitlement = projectedEntitlement;
	}

	if (projectedOperationName === null && blocksManagement(entitlement)) {
		return { action: "hidden", target: null, unavailableReason: null };
	}

	const target: PlanChangeTarget = {
		deploymentId,
		currentPlanSlug: planSlug,
		initialPlanSlug: includedBasic ? COMPUTE_PERFORMANCE_SLUG : planSlug,
		currentBillingTermMonths: planChangeBillingTerm(entitlement.billingTermMonths),
		currentFundingSource: fundingSource === "wallet" ? "wallet" : "stripe",
		status:
			entitlement.status === "unpaid" || entitlement.paymentState === "unpaid"
				? "unpaid"
				: entitlement.status === "past_due" || entitlement.paymentState === "past_due"
					? "past_due"
					: entitlement.status,
		paymentSourceOnly: entitlement.status === "past_due" || entitlement.paymentState === "past_due",
		cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
		isPaidCompute: !includedBasic,
		allowCombinedChange: includedBasic,
		projectedOperationName,
	};
	if (terminalFallback && projectedOperationName === null) {
		return { action: "hidden", target, unavailableReason: null };
	}

	if (projectedOperationName) {
		return { action: "enabled", target, unavailableReason: null };
	}
	if (includedBasic && plansError) {
		return {
			action: "disabled",
			target: null,
			unavailableReason: COMPUTE_PLANS_UNAVAILABLE_REASON,
		};
	}

	const targetUnavailableReason = planChangeTargetUnavailableReason({
		canCreateCloudAgents,
		target,
	});
	const deploymentStatus = deployment
		? deploymentStatusFromResource(deployment.resource.status)
		: null;
	const unavailableReason = includedBasic
		? performanceUpgradeUnavailableReason({
				plansLoading,
				canCreateCloudAgents,
				isIncludedBasic: true,
				performancePlanAvailable,
				pendingPlanSlug: null,
				planChangeUnavailable: targetUnavailableReason,
				deploymentStatusSupportsUpgrade: deploymentStatus
					? isRunningStatus(deploymentStatus) || deploymentStatus.kind === "stopped"
					: false,
				upgradeAvailable: deployment?.upgrade_available ?? false,
				upgradeEligibilityReason: deployment?.upgrade_eligibility.reason ?? null,
			})
		: targetUnavailableReason;

	return unavailableReason
		? { action: "disabled", target: null, unavailableReason }
		: { action: "enabled", target, unavailableReason: null };
}
