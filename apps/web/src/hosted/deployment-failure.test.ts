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
		const operation: DeploymentOperation = {
			name: "operations/restart-failed",
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: "hdep_failed",
				verb: "restart",
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
				type: "https://api.clawdi.ai/problems/runtime-readiness-timeout",
				title: "Runtime restart failed",
				status: 504,
				detail: "The runtime did not become ready before the deadline.",
				instance: "hdep_failed",
				code: "runtime_readiness_timeout",
				phase: "readiness",
				retryable: true,
				conditionReason: "RuntimeReadinessTimeout",
				conditionMessage: "The runtime did not become ready.",
				observedGeneration: 2,
			},
		});

		expect(deploymentFailureProjection(deployment)).toEqual({
			reason: "Runtime restart failed",
			failedVerb: "restart",
			retryable: true,
			code: "runtime_readiness_timeout",
		});
	});

	test("does not expose a stale failure outside the authoritative failed state", () => {
		const deployment = hostedDeploymentFixture({ status: "starting" });
		expect(deploymentFailureProjection(deployment)).toBeNull();
	});
});
