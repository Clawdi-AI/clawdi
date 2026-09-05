import type { HostedComputeSubscription } from "@/hosted/billing/contracts";
import type { ComputeSubscriptionManagementResult } from "./compute-subscription-management";
import type { ComputeRecoveryTarget } from "./compute-subscription-recovery";
import { computeFundingSource } from "./subscription-utils";

export type ComputeSubscriptionActionKind =
	| "upgrade"
	| "manage"
	| "cancel"
	| "end_trial"
	| "resume"
	| "fix_payment"
	| "top_up"
	| "start_new"
	| "check_change"
	| "cancel_scheduled_change";

type ComputeSubscriptionRecoveryAction = {
	kind: Extract<ComputeSubscriptionActionKind, "fix_payment" | "top_up" | "start_new">;
	disabledReason: string | null;
	recoveryTarget: ComputeRecoveryTarget;
};

type ComputeSubscriptionDirectAction = {
	kind: Exclude<ComputeSubscriptionActionKind, ComputeSubscriptionRecoveryAction["kind"]>;
	disabledReason: string | null;
};

export type ComputeSubscriptionAction =
	| ComputeSubscriptionDirectAction
	| ComputeSubscriptionRecoveryAction;

export type ComputeSubscriptionActionEntitlement = {
	subscriptionKind?: "included_basic" | "paid";
	deploymentId: string | null | undefined;
	planSlug: string | null | undefined;
	fundingSource: "stripe" | "wallet" | null | undefined;
	priceCents: number | null | undefined;
	status: string;
	paymentState: string;
	cancelAtPeriodEnd: boolean;
	pendingPlanSlug: string | null | undefined;
	isOrphan?: boolean;
	actions?: HostedComputeSubscription["actions"];
};

function action(
	kind: ComputeSubscriptionDirectAction["kind"],
	disabledReason: string | null = null,
): ComputeSubscriptionDirectAction {
	return { kind, disabledReason };
}

function planAction(
	management: ComputeSubscriptionManagementResult,
	kind: Extract<ComputeSubscriptionActionKind, "manage" | "upgrade"> = "manage",
): ComputeSubscriptionAction | null {
	if (management.action === "hidden") return null;
	return action(kind, management.action === "disabled" ? management.unavailableReason : null);
}

function recoveryAction(target: ComputeRecoveryTarget): ComputeSubscriptionRecoveryAction {
	return {
		kind: target.action,
		disabledReason: null,
		recoveryTarget: target,
	};
}

/**
 * Resolves the ordered, mutually compatible actions for one compute entitlement.
 * Callers own only context-specific execution such as navigation or opening dialogs.
 */
export function resolveComputeSubscriptionActions({
	entitlement,
	management,
	recoveryTarget,
	hasPendingOperation = false,
	startNewUnavailableReason = null,
}: {
	entitlement: ComputeSubscriptionActionEntitlement;
	management: ComputeSubscriptionManagementResult;
	recoveryTarget: ComputeRecoveryTarget | null;
	hasPendingOperation?: boolean;
	startNewUnavailableReason?: string | null;
}): readonly ComputeSubscriptionAction[] {
	const status = entitlement.status.toLowerCase();
	const deploymentBound = Boolean(entitlement.deploymentId?.trim()) && !entitlement.isOrphan;
	const fundingSource = computeFundingSource(entitlement.planSlug, {
		funding_source: entitlement.fundingSource,
		price_cents: entitlement.priceCents,
	});
	const paid =
		entitlement.subscriptionKind === "paid" ||
		(entitlement.subscriptionKind === undefined &&
			(fundingSource === "stripe" || fundingSource === "wallet"));
	const canCancel = entitlement.actions?.cancel != null;
	const cancel = canCancel
		? action(entitlement.actions?.cancel === "end_trial" ? "end_trial" : "cancel")
		: null;

	if (entitlement.actions?.command_state != null) return [];
	if (hasPendingOperation) return [action("check_change")];

	if (recoveryTarget?.kind === "start_new") {
		if (!deploymentBound) return [];
		return [
			{
				...recoveryAction(recoveryTarget),
				disabledReason: startNewUnavailableReason,
			},
		];
	}
	const recovery = recoveryTarget ? recoveryAction(recoveryTarget) : null;

	if (entitlement.pendingPlanSlug != null) {
		return [
			...(recovery ? [recovery] : []),
			action("cancel_scheduled_change"),
			...(cancel ? [cancel] : []),
		];
	}

	if (entitlement.actions?.resume) {
		return [...(recovery ? [recovery] : []), action("resume"), ...(cancel ? [cancel] : [])];
	}

	if (!paid) {
		const upgrade = !entitlement.isOrphan ? planAction(management, "upgrade") : null;
		return recovery ? [recovery] : upgrade ? [upgrade] : [];
	}

	const manage = !entitlement.isOrphan ? planAction(management) : null;
	if (recovery) {
		return [recovery, ...(manage ? [manage] : []), ...(cancel ? [cancel] : [])];
	}

	if (status === "trialing") return cancel ? [cancel] : [];

	if (status === "active" || status === "past_due") {
		return [...(manage ? [manage] : []), ...(cancel ? [cancel] : [])];
	}

	return [];
}
