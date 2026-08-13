import { describe, expect, test } from "bun:test";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	type ComputeSubscriptionEntitlement,
	computeSubscriptionManagement,
} from "./compute-subscription-management";

function entitlement(
	overrides: Partial<ComputeSubscriptionEntitlement> = {},
): ComputeSubscriptionEntitlement {
	return {
		deploymentId: "hdep_included",
		planSlug: "compute_basic",
		fundingSource: null,
		priceCents: 0,
		billingTermMonths: 1,
		status: "active",
		paymentState: "ok",
		cancelAtPeriodEnd: false,
		recoveryAction: null,
		pendingPlanSlug: null,
		...overrides,
	};
}

function includedDeployment() {
	return hostedDeploymentFixture({
		id: "hdep_included",
		currentPlanSlug: "compute_basic",
		upgradeAvailable: true,
		computeSubscription: {
			subscription_id: 7,
			status: "active",
			funding_source: null,
			payment_state: "ok",
			billing_term_months: 1,
			price_cents: 0,
			currency: "usd",
			cancel_at_period_end: false,
		},
	});
}

const available = {
	canCreateCloudAgents: true,
	plansLoading: false,
	performancePlanAvailable: true,
};

describe("computeSubscriptionManagement", () => {
	test("maps Included Basic and paid entitlements into the same management target model", () => {
		const included = computeSubscriptionManagement({
			entitlement: entitlement(),
			deployment: includedDeployment(),
			...available,
		});
		const paid = computeSubscriptionManagement({
			entitlement: entitlement({ fundingSource: "wallet", priceCents: 900 }),
			...available,
		});

		expect(included).toMatchObject({
			action: "enabled",
			target: {
				currentPlanSlug: "compute_basic",
				initialPlanSlug: "compute_performance",
				currentFundingSource: "stripe",
				isPaidCompute: false,
				allowCombinedChange: true,
			},
		});
		expect(paid).toMatchObject({
			action: "enabled",
			target: {
				currentPlanSlug: "compute_basic",
				initialPlanSlug: "compute_basic",
				currentFundingSource: "wallet",
				isPaidCompute: true,
				allowCombinedChange: false,
			},
		});
	});

	test("keeps Included Basic management disabled until the gated deployment projection is available", () => {
		expect(
			computeSubscriptionManagement({ entitlement: entitlement(), ...available }),
		).toMatchObject({
			action: "disabled",
			unavailableReason: expect.stringContaining("compute details finish syncing"),
		});
		expect(
			computeSubscriptionManagement({
				entitlement: entitlement(),
				deployment: hostedDeploymentFixture({
					id: "hdep_included",
					currentPlanSlug: "compute_basic",
					upgradeAvailable: false,
					upgradeEligibility: {
						eligible: false,
						reason: "deployment_must_be_running_or_stopped",
					},
					computeSubscription: includedDeployment().commercial_display?.compute_subscription,
				}),
				...available,
			}),
		).toMatchObject({
			action: "disabled",
			unavailableReason: expect.stringContaining("running or stopped"),
		});
	});

	test("does not present ordinary management for recovery or terminal fallback states", () => {
		expect(
			computeSubscriptionManagement({
				entitlement: entitlement({ recoveryAction: "fix_payment" }),
				deployment: includedDeployment(),
				...available,
			}),
		).toEqual({ action: "hidden", target: null, unavailableReason: null });
		const fallback = hostedDeploymentFixture({
			id: "hdep_included",
			currentPlanSlug: "compute_basic",
			upgradeAvailable: false,
			computeSubscription: includedDeployment().commercial_display?.compute_subscription,
			fundingFact: {
				fact_kind: "funding_revoked",
				commercial_revision: 1,
				funding_source: "stripe",
				prior_plan_slug: "compute_performance",
				occurred_at: "2026-07-16T00:00:00Z",
				emitted_at: "2026-07-16T00:00:00Z",
			},
		});
		expect(
			computeSubscriptionManagement({
				entitlement: entitlement(),
				deployment: fallback,
				...available,
			}),
		).toMatchObject({
			action: "hidden",
			target: { deploymentId: "hdep_included", isPaidCompute: false },
		});

		const pendingFallback = {
			...fallback,
			accepted_operation: {
				name: "operations/pending-plan-change",
				metadata: {
					"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
					deploymentId: "hdep_included",
					verb: "plan_change",
					targetGeneration: 2,
					manifestETag: "etag_plan_change",
					createTime: "2026-07-16T00:00:00Z",
					updateTime: "2026-07-16T00:00:00Z",
				},
				done: false,
			},
		} satisfies HostedDeployment;
		expect(
			computeSubscriptionManagement({
				entitlement: entitlement(),
				deployment: pendingFallback,
				...available,
			}),
		).toMatchObject({
			action: "enabled",
			target: { projectedOperationName: "operations/pending-plan-change" },
		});
	});
});
