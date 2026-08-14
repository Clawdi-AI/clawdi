import type {
	ComputePlanSlug,
	HostedComputeSubscription,
	HostedDeployment,
} from "@/hosted/billing/contracts";
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
	paymentState: HostedComputeSubscription["payment_state"];
	cancelAtPeriodEnd: boolean;
	recoveryAction: HostedComputeSubscription["recovery_action"];
	pendingPlanSlug: string | null | undefined;
	isOrphan?: boolean;
};

export type ComputeSubscriptionManagementResult =
	| { action: "hidden"; target: PlanChangeTarget | null; unavailableReason: null }
	| { action: "disabled"; target: null; unavailableReason: string }
	| { action: "enabled"; target: PlanChangeTarget; unavailableReason: null };

const UPGRADE_DETAILS_UNAVAILABLE_REASON =
	"Upgrade availability will appear after this agent’s compute details finish syncing.";

function isComputePlanSlug(value: string | null | undefined): value is ComputePlanSlug {
	return value === COMPUTE_BASIC_SLUG || value === COMPUTE_PERFORMANCE_SLUG;
}

function isPaymentSourceOnlyManagement(
	entitlement: ComputeSubscriptionEntitlement,
	paid: boolean,
): boolean {
	return (
		paid &&
		(entitlement.status === "past_due" ||
			entitlement.paymentState === "past_due" ||
			entitlement.paymentState === "requires_action") &&
		entitlement.paymentState !== "unpaid" &&
		entitlement.recoveryAction !== "start_new"
	);
}

function blocksManagement(entitlement: ComputeSubscriptionEntitlement, paid: boolean): boolean {
	const paymentSourceOnly = isPaymentSourceOnlyManagement(entitlement, paid);
	return (
		entitlement.cancelAtPeriodEnd ||
		(entitlement.status !== "active" && entitlement.status !== "past_due") ||
		(!paymentSourceOnly &&
			(entitlement.paymentState !== "ok" || entitlement.recoveryAction != null)) ||
		entitlement.pendingPlanSlug != null
	);
}

export function computeSubscriptionManagement({
	entitlement,
	deployment,
	canCreateCloudAgents,
	plansLoading,
	performancePlanAvailable,
}: {
	entitlement: ComputeSubscriptionEntitlement;
	deployment?: HostedDeployment | null;
	canCreateCloudAgents: boolean;
	plansLoading: boolean;
	performancePlanAvailable: boolean;
}): ComputeSubscriptionManagementResult {
	if (entitlement.isOrphan) {
		return { action: "hidden", target: null, unavailableReason: null };
	}
	const deploymentId = entitlement.deploymentId?.trim();
	const planSlug = isComputePlanSlug(entitlement.planSlug) ? entitlement.planSlug : null;
	if (!deploymentId || !planSlug) {
		return { action: "hidden", target: null, unavailableReason: null };
	}

	const fundingSource = computeFundingSource(entitlement.planSlug, {
		funding_source: entitlement.fundingSource,
		price_cents: entitlement.priceCents,
	});
	const includedBasic = fundingSource === "included_basic";
	const paid = fundingSource === "stripe" || fundingSource === "wallet";
	if (!includedBasic && !paid) {
		return { action: "hidden", target: null, unavailableReason: null };
	}
	const projectedOperationName = deployment ? activePlanChangeOperationName(deployment) : null;
	if (projectedOperationName === null && blocksManagement(entitlement, paid)) {
		return { action: "hidden", target: null, unavailableReason: null };
	}

	const paymentSourceOnly = isPaymentSourceOnlyManagement(entitlement, paid);
	const target: PlanChangeTarget = {
		deploymentId,
		currentPlanSlug: planSlug,
		initialPlanSlug: includedBasic ? COMPUTE_PERFORMANCE_SLUG : planSlug,
		currentBillingTermMonths: planChangeBillingTerm(entitlement.billingTermMonths),
		currentFundingSource: fundingSource === "wallet" ? "wallet" : "stripe",
		status:
			entitlement.status === "unpaid" || entitlement.paymentState === "unpaid"
				? "unpaid"
				: paymentSourceOnly
					? "past_due"
					: entitlement.status,
		paymentSourceOnly,
		cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
		isPaidCompute: !includedBasic,
		allowCombinedChange: includedBasic,
		projectedOperationName,
	};
	if (projectedOperationName) {
		return { action: "enabled", target, unavailableReason: null };
	}

	const targetUnavailableReason = planChangeTargetUnavailableReason({
		canCreateCloudAgents,
		target,
	});
	if (includedBasic) {
		if (!deployment || deployment.resource.id.toLowerCase() !== deploymentId.toLowerCase()) {
			return {
				action: "disabled",
				target: null,
				unavailableReason: UPGRADE_DETAILS_UNAVAILABLE_REASON,
			};
		}
		const deploymentStatus = deploymentStatusFromResource(deployment.resource.status);
		const unavailableReason = performanceUpgradeUnavailableReason({
			plansLoading,
			canCreateCloudAgents,
			isIncludedBasic: true,
			performancePlanAvailable,
			pendingPlanSlug: isComputePlanSlug(entitlement.pendingPlanSlug)
				? entitlement.pendingPlanSlug
				: null,
			planChangeUnavailable: targetUnavailableReason,
			deploymentStatusSupportsUpgrade:
				isRunningStatus(deploymentStatus) || deploymentStatus.kind === "stopped",
			upgradeAvailable: deployment.upgrade_available,
			upgradeEligibilityReason: deployment.upgrade_eligibility.reason,
		});
		return unavailableReason
			? { action: "disabled", target: null, unavailableReason }
			: { action: "enabled", target, unavailableReason: null };
	}
	return targetUnavailableReason
		? { action: "disabled", target: null, unavailableReason: targetUnavailableReason }
		: { action: "enabled", target, unavailableReason: null };
}
