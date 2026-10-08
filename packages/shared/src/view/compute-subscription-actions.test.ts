import { describe, expect, test } from "bun:test";

import {
	type ComputeSubscriptionActionEntitlement,
	resolveComputeSubscriptionActions,
	resolveStoreSubscriptionActions,
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
		actions: { cancel: "cancel_at_period_end", resume: false, command_state: null },
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
		expect(
			kinds({
				status: "trialing",
				actions: { cancel: "end_trial", resume: false, command_state: null },
			}),
		).toEqual(["end_trial"]);
		expect(
			kinds(
				{ planSlug: "compute_basic", fundingSource: null, priceCents: 0, actions: null },
				{ management: enabledManagement },
			),
		).toEqual(["upgrade"]);
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
		expect(
			kinds({
				cancelAtPeriodEnd: true,
				actions: { cancel: null, resume: true, command_state: null },
			}),
		).toEqual(["resume"]);
		expect(
			kinds({
				status: "trialing",
				cancelAtPeriodEnd: true,
				actions: { cancel: "end_trial", resume: true, command_state: null },
			}),
		).toEqual(["resume", "end_trial"]);
		const unpaid = resolveComputeSubscriptionActions({
			entitlement: entitlement({ status: "unpaid", paymentState: "unpaid", actions: null }),
			management: enabledManagement,
			recoveryTarget: null,
		});
		expect(unpaid).toEqual([]);
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
		for (const status of ["canceled", "unpaid", "expired", "incomplete", "paused"]) {
			expect(kinds({ status, actions: null }, { management: hiddenManagement }), status).toEqual(
				[],
			);
			expect(
				kinds(
					{ status, actions: null },
					{
						management: hiddenManagement,
						recoveryTarget: { kind: "fix_payment", action: "fix_payment" },
					},
				),
				status,
			).toEqual(["fix_payment"]);
		}
		expect(kinds({ actions: { cancel: null, resume: false, command_state: "pending" } })).toEqual(
			[],
		);
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
			kinds({
				cancelAtPeriodEnd: true,
				status: "canceling",
				pendingPlanSlug: "compute_basic",
				actions: null,
			}),
		).toEqual(["cancel_scheduled_change"]);
	});

	test("keeps payment recovery ahead of resuming a canceling subscription", () => {
		expect(
			kinds(
				{
					status: "past_due",
					paymentState: "requires_action",
					cancelAtPeriodEnd: true,
					actions: { cancel: null, resume: true, command_state: null },
				},
				{ recoveryTarget: { kind: "fix_payment", action: "fix_payment" } },
			),
		).toEqual(["fix_payment", "resume"]);
		expect(
			kinds({ deploymentId: null, isOrphan: true, status: "canceling", actions: null }),
		).toEqual([]);
	});

	test("never offers Stripe actions on store rows, only a server-offered replacement", () => {
		const storeRow = {
			fundingSource: "store" as const,
			subscriptionKind: "paid" as const,
			actions: { cancel: null, resume: false, command_state: null },
		};
		for (const status of ["active", "past_due", "trialing"]) {
			expect(kinds({ ...storeRow, status })).toEqual([]);
			expect(kinds({ ...storeRow, status }, { hasPendingOperation: true })).toEqual([]);
		}
		expect(
			kinds(
				{ ...storeRow, status: "past_due", paymentState: "past_due" },
				{ recoveryTarget: { kind: "fix_payment", action: "fix_payment" } },
			),
		).toEqual([]);
		expect(
			kinds({ ...storeRow, pendingPlanSlug: "compute_basic", cancelAtPeriodEnd: true }),
		).toEqual([]);
		expect(
			kinds(
				{ ...storeRow, status: "canceled" },
				{ recoveryTarget: { kind: "start_new", action: "start_new" } },
			),
		).toEqual(["start_new"]);
		expect(
			kinds(
				{ ...storeRow, status: "canceled", deploymentId: null, isOrphan: true },
				{ recoveryTarget: { kind: "start_new", action: "start_new" } },
			),
		).toEqual([]);
	});
});

describe("resolveStoreSubscriptionActions", () => {
	const management = {
		contract_id: "11111111-1111-4111-8111-111111111111",
		provider: "play_store" as const,
		product_id: "ai.clawdi.app.compute:basic-monthly",
		management_url: null,
		auto_renews: true,
		renews_or_ends_at: "2026-11-08T00:00:00Z",
		state: "active",
	};

	test("the billing store's own platform can change plan and manage", () => {
		expect(resolveStoreSubscriptionActions({ management, platform: "play_store" })).toEqual({
			actions: ["change_store_plan", "manage_store_subscription"],
			managedElsewhere: null,
		});
		for (const state of ["grace", "lapsed", "paused", "canceled_pending_end", "conflict_hold"]) {
			expect(
				resolveStoreSubscriptionActions({
					management: { ...management, state },
					platform: "play_store",
				}).actions,
			).toEqual(["manage_store_subscription"]);
		}
	});

	test("a subscription billed by the other store has no actions and names that store", () => {
		expect(resolveStoreSubscriptionActions({ management, platform: "app_store" })).toEqual({
			actions: [],
			managedElsewhere: "play_store",
		});
	});

	test("ended contracts, Test Store and missing projections have no actions", () => {
		for (const state of ["expired", "revoked", "owner_terminated"]) {
			expect(
				resolveStoreSubscriptionActions({
					management: { ...management, state },
					platform: "play_store",
				}),
			).toEqual({ actions: [], managedElsewhere: null });
		}
		expect(
			resolveStoreSubscriptionActions({
				management: { ...management, provider: "test_store" },
				platform: "play_store",
			}),
		).toEqual({ actions: [], managedElsewhere: null });
		expect(resolveStoreSubscriptionActions({ management: null, platform: "app_store" })).toEqual({
			actions: [],
			managedElsewhere: null,
		});
	});
});
