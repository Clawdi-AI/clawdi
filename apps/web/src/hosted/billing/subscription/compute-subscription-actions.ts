import type { ComputeSubscriptionManagementResult } from "./compute-subscription-management";
import type { ComputeRecoveryTarget } from "./compute-subscription-recovery";
import { computeFundingSource } from "./subscription-utils";

export type ComputeSubscriptionActionKind =
	| "upgrade"
	| "manage"
	| "cancel"
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
	deploymentId: string | null | undefined;
	planSlug: string | null | undefined;
	fundingSource: "stripe" | "wallet" | null | undefined;
	priceCents: number | null | undefined;
	status: string;
	paymentState: string;
	cancelAtPeriodEnd: boolean;
	pendingPlanSlug: string | null | undefined;
	isOrphan?: boolean;
};

const TERMINAL_STATUSES = new Set([
	"canceled",
	"expired",
	"incomplete",
	"incomplete_expired",
	"paused",
]);
const CANCELABLE_STATUSES = new Set(["trialing", "active", "past_due"]);

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
	const paid = fundingSource === "stripe" || fundingSource === "wallet";
	const canCancel = paid && !entitlement.cancelAtPeriodEnd && CANCELABLE_STATUSES.has(status);
	const cancel = canCancel ? action("cancel") : null;

	if (hasPendingOperation) return [action("check_change")];

	if (
		recoveryTarget?.kind === "start_new" ||
		entitlement.paymentState === "unpaid" ||
		status === "unpaid"
	) {
		if (!deploymentBound) return [];
		const startNewTarget: ComputeRecoveryTarget = { kind: "start_new", action: "start_new" };
		return [
			{
				...recoveryAction(recoveryTarget?.kind === "start_new" ? recoveryTarget : startNewTarget),
				disabledReason: startNewUnavailableReason,
			},
		];
	}
	if (TERMINAL_STATUSES.has(status)) return [];

	const recovery = recoveryTarget ? recoveryAction(recoveryTarget) : null;

	if (entitlement.pendingPlanSlug != null) {
		return [
			...(recovery ? [recovery] : []),
			action("cancel_scheduled_change"),
			...(cancel ? [cancel] : []),
		];
	}

	if (paid && (entitlement.cancelAtPeriodEnd || status === "canceling")) {
		return [...(recovery ? [recovery] : []), ...(deploymentBound ? [action("resume")] : [])];
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
