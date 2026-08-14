import { describe, expect, test } from "bun:test";
import {
	computeSubscriptionActionRequest,
	scheduledPlanCancellationNotice,
} from "./compute-subscription-action-list";
import {
	type ComputeSubscriptionActionEntitlement,
	resolveComputeSubscriptionActions,
} from "./compute-subscription-actions";
import type { ComputeSubscriptionManagementResult } from "./compute-subscription-management";

const enabledManagement: ComputeSubscriptionManagementResult = {
	action: "enabled",
	target: {
		deploymentId: "hdep_agent",
		currentPlanSlug: "compute_performance",
		initialPlanSlug: "compute_performance",
		currentBillingTermMonths: 1,
		currentFundingSource: "stripe",
		status: "active",
		paymentSourceOnly: false,
		cancelAtPeriodEnd: false,
		isPaidCompute: true,
		allowCombinedChange: false,
		projectedOperationName: null,
	},
	unavailableReason: null,
};

const hiddenManagement: ComputeSubscriptionManagementResult = {
	action: "hidden",
	target: null,
	unavailableReason: null,
};

function entitlement(
	overrides: Partial<ComputeSubscriptionActionEntitlement> = {},
): ComputeSubscriptionActionEntitlement {
	return {
		deploymentId: "hdep_agent",
		planSlug: "compute_performance",
		fundingSource: "stripe",
		priceCents: 1_900,
		status: "active",
		paymentState: "ok",
		cancelAtPeriodEnd: false,
		pendingPlanSlug: null,
		isOrphan: false,
		...overrides,
	};
}

function kinds(
	overrides: Partial<ComputeSubscriptionActionEntitlement> = {},
	options: {
		management?: ComputeSubscriptionManagementResult;
		recoveryTarget?: Parameters<typeof resolveComputeSubscriptionActions>[0]["recoveryTarget"];
		hasPendingOperation?: boolean;
	} = {},
) {
	return resolveComputeSubscriptionActions({
		entitlement: entitlement(overrides),
		management: options.management ?? enabledManagement,
		recoveryTarget: options.recoveryTarget ?? null,
		hasPendingOperation: options.hasPendingOperation,
	}).map((candidate) => candidate.kind);
}

describe("resolveComputeSubscriptionActions", () => {
	test("covers healthy paid, trial, Included Basic, and orphan entitlements", () => {
		expect(kinds()).toEqual(["manage", "cancel"]);
		expect(kinds({ status: "trialing" })).toEqual(["cancel"]);
		expect(
			kinds(
				{ planSlug: "compute_basic", fundingSource: null, priceCents: 0 },
				{ management: enabledManagement },
			),
		).toEqual([]);
		expect(kinds({ deploymentId: null, isOrphan: true })).toEqual(["cancel"]);
	});

	test("keeps paid recovery, payment-source management, and legal cancellation", () => {
		expect(
			kinds(
				{ status: "past_due", paymentState: "requires_action" },
				{ recoveryTarget: { kind: "fix_payment", action: "fix_payment" } },
			),
		).toEqual(["fix_payment", "manage", "cancel"]);
		expect(
			kinds(
				{ status: "past_due", paymentState: "past_due", fundingSource: "wallet" },
				{ recoveryTarget: { kind: "top_up", action: "top_up" } },
			),
		).toEqual(["top_up", "manage", "cancel"]);
		expect(kinds({ status: "past_due", paymentState: "ok" })).toEqual(["manage", "cancel"]);
		const orphanCardRecovery = resolveComputeSubscriptionActions({
			entitlement: entitlement({
				deploymentId: null,
				isOrphan: true,
				status: "past_due",
				paymentState: "requires_action",
			}),
			management: hiddenManagement,
			recoveryTarget: { kind: "fix_payment", action: "fix_payment" },
		});
		expect(orphanCardRecovery.map(({ kind }) => kind)).toEqual(["fix_payment", "cancel"]);
		expect(orphanCardRecovery[0]?.disabledReason).toBeNull();
	});

	test("gives pending, canceling, and terminal states exclusive recovery priority", () => {
		expect(kinds({}, { hasPendingOperation: true })).toEqual(["check_change"]);
		expect(kinds({ cancelAtPeriodEnd: true })).toEqual(["resume"]);
		const unpaid = resolveComputeSubscriptionActions({
			entitlement: entitlement({ status: "unpaid", paymentState: "unpaid" }),
			management: enabledManagement,
			recoveryTarget: null,
		});
		expect(unpaid.map(({ kind }) => kind)).toEqual(["start_new"]);
		expect(unpaid[0]).toMatchObject({
			kind: "start_new",
			recoveryTarget: { kind: "start_new" },
		});
		const terminalRecovery = resolveComputeSubscriptionActions({
			entitlement: entitlement({ status: "canceled", paymentState: "ok" }),
			management: enabledManagement,
			recoveryTarget: { kind: "start_new", action: "start_new" },
		});
		expect(terminalRecovery.map(({ kind }) => kind)).toEqual(["start_new"]);
		expect(terminalRecovery[0]).toMatchObject({
			kind: "start_new",
			recoveryTarget: { kind: "start_new" },
		});
		expect(kinds({ status: "canceled", paymentState: "unpaid" })).toEqual(["start_new"]);
		for (const status of ["canceled", "expired", "incomplete", "paused"]) {
			expect(kinds({ status }, { management: hiddenManagement }), status).toEqual([]);
		}
	});

	test("keeps scheduled-downgrade cancellation ahead of subscription cancellation", () => {
		expect(kinds({ pendingPlanSlug: "compute_basic" })).toEqual([
			"cancel_scheduled_change",
			"cancel",
		]);
		expect(
			kinds(
				{
					status: "past_due",
					paymentState: "requires_action",
					pendingPlanSlug: "compute_basic",
				},
				{ recoveryTarget: { kind: "fix_payment", action: "fix_payment" } },
			),
		).toEqual(["fix_payment", "cancel_scheduled_change", "cancel"]);
		expect(
			kinds({ cancelAtPeriodEnd: true, status: "canceling", pendingPlanSlug: "compute_basic" }),
		).toEqual(["cancel_scheduled_change"]);
	});

	test("keeps payment recovery ahead of resuming a canceling subscription", () => {
		expect(
			kinds(
				{ status: "past_due", paymentState: "requires_action", cancelAtPeriodEnd: true },
				{ recoveryTarget: { kind: "fix_payment", action: "fix_payment" } },
			),
		).toEqual(["fix_payment", "resume"]);
		expect(kinds({ deploymentId: null, isOrphan: true, status: "canceling" })).toEqual([]);
	});
});

describe("scheduled plan cancellation execution", () => {
	test("uses the exact public target and never reports pending work as success", () => {
		expect(
			computeSubscriptionActionRequest({ kind: "deployment", deploymentId: "hdep_agent" }),
		).toEqual({ deployment_id: "hdep_agent" });
		expect(
			computeSubscriptionActionRequest({
				kind: "subscription",
				subscriptionId: "csub_account",
				deploymentId: null,
			}),
		).toEqual({ subscription_id: "csub_account" });

		const result = {
			status: "active",
			billing_term_months: 1,
			cancel_at_period_end: false,
		};
		expect(scheduledPlanCancellationNotice({ ...result, action_state: "removed" })).toMatchObject({
			kind: "success",
			title: "Scheduled plan change canceled",
		});
		for (const actionState of ["pending", "reconciling"] as const) {
			expect(
				scheduledPlanCancellationNotice({ ...result, action_state: actionState }),
			).toMatchObject({ kind: "info" });
		}
	});
});
