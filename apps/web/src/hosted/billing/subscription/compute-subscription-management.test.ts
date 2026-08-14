import { describe, expect, test } from "bun:test";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	type ComputeSubscriptionEntitlement,
	computeSubscriptionManagement,
} from "./compute-subscription-management";

function entitlement(
	overrides: Partial<ComputeSubscriptionEntitlement> = {},
): ComputeSubscriptionEntitlement {
	return {
		deploymentId: "hdep_agent",
		planSlug: "compute_basic",
		fundingSource: "stripe",
		priceCents: 900,
		billingTermMonths: 1,
		status: "active",
		paymentState: "ok",
		cancelAtPeriodEnd: false,
		recoveryAction: null,
		pendingPlanSlug: null,
		...overrides,
	};
}

const available = {
	canCreateCloudAgents: true,
	plansLoading: false,
	performancePlanAvailable: true,
};

describe("computeSubscriptionManagement", () => {
	test("exposes stable Included Basic as an explicit upgrade target", () => {
		const included = entitlement({ fundingSource: null, priceCents: 0 });

		expect(computeSubscriptionManagement({ entitlement: included, ...available })).toEqual({
			action: "disabled",
			target: null,
			unavailableReason:
				"Upgrade availability will appear after this agent’s compute details finish syncing.",
		});
		expect(
			computeSubscriptionManagement({
				entitlement: included,
				deployment: hostedDeploymentFixture({
					id: "hdep_agent",
					currentPlanSlug: "compute_basic",
					upgradeAvailable: true,
				}),
				...available,
			}),
		).toMatchObject({
			action: "enabled",
			target: {
				currentPlanSlug: "compute_basic",
				initialPlanSlug: "compute_performance",
				isPaidCompute: false,
				allowCombinedChange: true,
			},
		});
	});

	test("keeps an already-started Included Basic change observable", () => {
		const deployment = hostedDeploymentFixture({
			id: "hdep_agent",
			currentPlanSlug: "compute_basic",
		});
		deployment.accepted_operation = {
			name: "operations/pending-plan-change",
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: "hdep_agent",
				verb: "plan_change",
				targetGeneration: 2,
				manifestETag: "etag_plan_change",
				createTime: "2026-07-16T00:00:00Z",
				updateTime: "2026-07-16T00:00:00Z",
			},
			done: false,
		};

		expect(
			computeSubscriptionManagement({
				entitlement: entitlement({ fundingSource: null, priceCents: 0 }),
				deployment,
				...available,
			}),
		).toMatchObject({
			action: "enabled",
			target: {
				isPaidCompute: false,
				projectedOperationName: "operations/pending-plan-change",
			},
		});
	});

	test("keeps healthy paid management and payment recovery explicit", () => {
		expect(
			computeSubscriptionManagement({
				entitlement: entitlement({ fundingSource: "wallet" }),
				...available,
			}),
		).toMatchObject({
			action: "enabled",
			target: {
				currentFundingSource: "wallet",
				isPaidCompute: true,
				paymentSourceOnly: false,
			},
		});
		expect(
			computeSubscriptionManagement({
				entitlement: entitlement({
					paymentState: "requires_action",
					recoveryAction: "fix_payment",
				}),
				...available,
			}),
		).toMatchObject({
			action: "enabled",
			target: { status: "past_due", paymentSourceOnly: true },
		});
	});

	test("hides ordinary management for invalid, canceling, and scheduled targets", () => {
		for (const overrides of [
			{ deploymentId: null },
			{ cancelAtPeriodEnd: true },
			{ pendingPlanSlug: "compute_performance" },
			{ status: "canceled" },
		] satisfies Partial<ComputeSubscriptionEntitlement>[]) {
			expect(
				computeSubscriptionManagement({ entitlement: entitlement(overrides), ...available }),
			).toEqual({ action: "hidden", target: null, unavailableReason: null });
		}
	});
});
