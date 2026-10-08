import type { DeploymentMutation, DeploymentRead } from "../api";

type HostedComputeSubscription = NonNullable<
	NonNullable<DeploymentRead["commercial_display"]>["compute_subscription"]
>;

import type { ComputeRecoveryTarget } from "../api/compute-recovery";
import type { StorePlatform } from "../api/store-client";
import type { ComputeSubscriptionManagementResult } from "./compute-subscription-management";
import {
	computeFundingMode,
	computeFundingSource,
	isComputeSubscriptionRenewing,
} from "./compute-subscriptions";
import {
	isStoreManagementOnOtherStore,
	isStoreManagementOnPlatform,
	isStoreManagementTerminal,
	type StoreManagement,
	type StoreManagementProvider,
	storeAgentDeletionNotice,
} from "./store-management";

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
	fundingSource: "stripe" | "wallet" | "store" | null | undefined;
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
	if (fundingSource === "store") {
		// Store billing is managed on the purchasing device. The only Web action is the
		// server-offered replacement for an Agent whose store contract has ended.
		return recoveryTarget?.kind === "start_new" && deploymentBound
			? [{ ...recoveryAction(recoveryTarget), disabledReason: startNewUnavailableReason }]
			: [];
	}
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

export type StoreSubscriptionActionKind = "change_store_plan" | "manage_store_subscription";

export type StoreSubscriptionActions = {
	actions: readonly StoreSubscriptionActionKind[];
	/** Billed by the other platform's store: managed on that device, with no link here. */
	managedElsewhere: Exclude<StoreManagementProvider, "test_store"> | null;
};

/**
 * Platform-aware extension of `resolveComputeSubscriptionActions` for the Clawdi app on
 * a store platform. Web has no store platform and keeps store rows read-only. Only the
 * store that bills a subscription can change or manage it; plan changes are offered
 * while the contract is active, and the server validates every transition.
 */
export function resolveStoreSubscriptionActions({
	management,
	platform,
}: {
	management: StoreManagement | null | undefined;
	platform: StorePlatform;
}): StoreSubscriptionActions {
	if (!management || isStoreManagementTerminal(management)) {
		return { actions: [], managedElsewhere: null };
	}
	if (isStoreManagementOnOtherStore(management, platform)) {
		return {
			actions: [],
			managedElsewhere: management.provider,
		};
	}
	if (!isStoreManagementOnPlatform(management, platform)) {
		return { actions: [], managedElsewhere: null };
	}
	return {
		actions:
			management.state === "active"
				? ["change_store_plan", "manage_store_subscription"]
				: ["manage_store_subscription"],
		managedElsewhere: null,
	};
}

type DeleteTarget = {
	current_plan_slug?: DeploymentRead["current_plan_slug"];
	commercial_display?: { compute_subscription?: HostedComputeSubscription | null } | null;
};
type SubscriptionChoice = Extract<
	DeploymentMutation,
	{ action: "delete" }
>["body"]["subscription_choice"];

/**
 * Included Basic is released with the Agent, a
 * renewing card/Wallet subscription is the owner's choice, and anything else is kept.
 * Deleting never cancels App Store/Google Play billing, so store rows offer no choice
 * and show the store notice instead.
 */
export function deploymentDeleteSubscriptionPolicy(deployment: DeleteTarget | null | undefined): {
	offerChoice: boolean;
	defaultChoice: SubscriptionChoice;
	storeNotice: string | null;
} {
	const subscription = deployment?.commercial_display?.compute_subscription;
	const fundingMode = computeFundingMode(deployment?.current_plan_slug, subscription);
	if (computeFundingSource(deployment?.current_plan_slug, subscription) === "store") {
		return {
			offerChoice: false,
			defaultChoice: "keep_subscription",
			storeNotice: storeAgentDeletionNotice(subscription?.store_management),
		};
	}
	return {
		offerChoice: fundingMode === "subscription" && isComputeSubscriptionRenewing(subscription),
		defaultChoice: fundingMode === "included_basic" ? "cancel_subscription" : "keep_subscription",
		storeNotice: null,
	};
}
