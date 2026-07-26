import { describe, expect, test } from "bun:test";
import type { DeploymentOperation } from "@/hosted/billing/contracts";
import { deploymentFailureProjection, deploymentFailureReason } from "@/hosted/deployment-failure";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

describe("deploymentFailureReason", () => {
	test("uses the compatibility Problem title instead of internal detail", () => {
		expect(
			deploymentFailureReason({
				failure: {
					title: "Runtime startup failed",
					conditionMessage: "The runtime did not become ready.",
				},
			}),
		).toBe("Runtime startup failed");
	});

	test("falls back to the condition message when the title is empty", () => {
		expect(
			deploymentFailureReason({
				failure: { title: "  ", conditionMessage: "The runtime did not become ready." },
			}),
		).toBe("The runtime did not become ready.");
	});

	test("projects the authoritative reason and failed verb for every tab", () => {
		const actionableReason =
			"Top up your wallet and retry the plan change. Operation ID: operations/plan-change-failed.";
		const operation: DeploymentOperation = {
			name: "operations/plan-change-failed",
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: "hdep_failed",
				verb: "plan_change" as DeploymentOperation["metadata"]["verb"],
				targetGeneration: 2,
				manifestETag: "manifest-failed",
				createTime: "2026-07-25T00:00:00Z",
				updateTime: "2026-07-25T00:01:00Z",
			},
			done: false,
			response: null,
		};
		const deployment = hostedDeploymentFixture({
			id: "hdep_failed",
			status: "failed",
			acceptedOperation: operation,
			failure: {
				type: "https://api.clawdi.ai/problems/operation_aborted",
				title: "Deployment operation was aborted",
				status: 409,
				detail: actionableReason,
				instance: "hdep_failed",
				code: "operation_aborted",
				phase: "plan_change",
				retryable: false,
				conditionReason: "OperationAborted",
				conditionMessage: "Deployment operation was aborted",
				observedGeneration: 2,
			},
		});

		expect(deploymentFailureProjection(deployment)).toEqual({
			reason: actionableReason,
			failedVerb: "plan_change",
			retryable: false,
			code: "operation_aborted",
		});
	});

	test("does not expose a stale failure outside the authoritative failed state", () => {
		const deployment = hostedDeploymentFixture({ status: "starting" });
		expect(deploymentFailureProjection(deployment)).toBeNull();
	});
});
