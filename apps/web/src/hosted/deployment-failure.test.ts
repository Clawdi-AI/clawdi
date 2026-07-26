import { describe, expect, test } from "bun:test";
import type { DeploymentOperation } from "@/hosted/billing/contracts";
import {
	deploymentFailurePresentation,
	deploymentFailureProjection,
	deploymentFailureReason,
} from "@/hosted/deployment-failure";
import type { DeploymentOperationVerb } from "@/hosted/deployment-status";
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
			reason: "Top up your wallet and retry the plan change.",
			failedVerb: "plan_change",
			retryable: false,
			code: "operation_aborted",
		});
		expect(deploymentFailurePresentation(deployment)).toEqual({
			reason: "Top up your wallet and retry the plan change.",
			failedVerb: "plan_change",
			retryable: false,
			code: "operation_aborted",
			title: "Plan change failed",
			description:
				"Open Compute settings to top up your Wallet, request a fresh quote, and confirm the price before retrying.",
			remediation: {
				kind: "review_plan_change",
				label: "Review plan",
				requiresWalletTopUp: true,
			},
		});
	});

	test("removes internal operation and deployment references from visible failures", () => {
		expect(
			deploymentFailureReason({
				failure: {
					title: " ",
					phase: "plan_change",
					detail:
						"Try again. Operation ID: operations/op-secret. Deployment ID: hdep_internal. Agent ID: 123e4567-e89b-42d3-a456-426614174000.",
					conditionMessage: "Plan change failed.",
				},
			}),
		).toBe("Try again.");
	});

	test("maps every failed operation to a truthful safe remediation", () => {
		const cases = [
			["create", "Agent setup failed", "restart"],
			["start", "Agent startup failed", "restart"],
			["stop", "Compute stop failed", "none"],
			["restart", "Compute restart failed", "restart"],
			["update", "Agent update failed", "none"],
			["runtime_switch", "Runtime switch failed", "none"],
			["rename", "Agent rename failed", "none"],
			["delete", "Agent deletion failed", "retry_delete"],
			["plan_change", "Plan change failed", "review_plan_change"],
		] as const satisfies readonly [DeploymentOperationVerb, string, string][];

		for (const [verb, title, remediationKind] of cases) {
			const deployment = hostedDeploymentFixture({
				status: "failed",
				acceptedOperation: {
					name: `operations/${verb}-failed`,
					metadata: {
						"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
						deploymentId: "hdep_failed",
						verb: verb as DeploymentOperation["metadata"]["verb"],
						targetGeneration: 2,
						manifestETag: "manifest-failed",
						createTime: "2026-07-25T00:00:00Z",
						updateTime: "2026-07-25T00:01:00Z",
					},
					done: false,
					response: null,
				},
				failure: {
					type: "https://api.clawdi.ai/problems/operation_failed",
					title: "The requested operation did not complete.",
					status: 409,
					detail: "The requested operation did not complete.",
					instance: "hdep_failed",
					code: "operation_failed",
					retryable: true,
					conditionReason: "OperationFailed",
					conditionMessage: "The requested operation did not complete.",
					observedGeneration: 2,
				},
			});
			const presentation = deploymentFailurePresentation(deployment);

			expect(presentation?.title).toBe(title);
			expect(presentation?.remediation.kind).toBe(remediationKind);
		}
	});

	test("does not expose a stale failure outside the authoritative failed state", () => {
		const deployment = hostedDeploymentFixture({ status: "starting" });
		expect(deploymentFailureProjection(deployment)).toBeNull();
	});
});
