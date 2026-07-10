import { describe, expect, test } from "bun:test";
import type { DeleteDeploymentResult } from "@/hosted/billing/contracts";
import { deleteDeploymentToastDecision } from "./delete-deployment-toast.logic";

function deleteResult(overrides: Partial<DeleteDeploymentResult> = {}): DeleteDeploymentResult {
	return {
		status: "deleted",
		cvm_deleted: true,
		subscription_cancel_failed: false,
		subscription: null,
		...overrides,
	};
}

describe("deleteDeploymentToastDecision", () => {
	test("keeps the plain success toast when no subscription is returned", () => {
		expect(deleteDeploymentToastDecision(deleteResult())).toEqual({
			tone: "success",
			title: "Agent deleted",
		});
	});

	test("explains period-end subscription cancellation", () => {
		expect(
			deleteDeploymentToastDecision(
				deleteResult({
					subscription: {
						cancel_at_period_end: true,
						current_period_end: "2026-08-01T00:00:00Z",
					},
				}),
			),
		).toEqual({
			tone: "success",
			title: "Agent deleted",
			description: "The subscription stays active until Aug 1, 2026 and won't renew.",
		});
	});

	test("warns when subscription cancellation failed", () => {
		expect(
			deleteDeploymentToastDecision(
				deleteResult({
					subscription_cancel_failed: true,
				}),
			),
		).toEqual({
			tone: "warning",
			title: "Check billing settings",
			description:
				"The compute was deleted, but we couldn't schedule subscription cancellation. Check billing settings before the next renewal.",
		});
	});
});
