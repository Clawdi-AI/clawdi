import { describe, expect, test } from "bun:test";
import type { DeploymentOperation } from "@/hosted/billing/contracts";
import { BillingApiError, BillingNetworkError } from "@/hosted/billing/errors";
import {
	deploymentFailurePresentation,
	deploymentFailureProjection,
	deploymentFailureReason,
	deploymentMutationErrorMessage,
} from "@/hosted/deployment-failure";
import type { DeploymentOperationVerb } from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

describe("deploymentFailureReason", () => {
	test("uses client-owned copy instead of a free-form Problem title or detail", () => {
		expect(
			deploymentFailureReason({
				failure: {
					title: "Runtime startup failed",
					conditionMessage: "The runtime did not become ready.",
				},
			}),
		).toBe("The Clawdi service could not complete this request.");
	});

	test("does not expose internal exceptions, identifiers, or implementation vocabulary", () => {
		expect(
			deploymentFailureReason({
				failure: {
					title: "MissingGreenlet during provisioning",
					detail:
						"SQLAlchemy failed for operations/op-secret and hdep_internal while reconciling the runtime.",
					conditionMessage:
						"Agent 123e4567-e89b-42d3-a456-426614174000 failed synchronous plan confirmation.",
					phase: "plan_change",
					code: "operation_aborted",
				},
			}),
		).toBe(
			"The Clawdi service could not confirm the plan change. Your plan was not changed and you were not charged.",
		);
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
			reason:
				"The Clawdi service could not confirm the plan change. Your plan was not changed and you were not charged.",
			failedVerb: "plan_change",
			retryable: false,
			code: "operation_aborted",
		});
		expect(deploymentFailurePresentation(deployment)).toEqual({
			reason:
				"The Clawdi service could not confirm the plan change. Your plan was not changed and you were not charged.",
			failedVerb: "plan_change",
			retryable: false,
			code: "operation_aborted",
			title: "Plan change failed",
			description: "Get a fresh quote and confirm the price before trying again.",
			remediation: {
				kind: "review_plan_change",
				label: "Get fresh quote",
				requiresWalletTopUp: false,
			},
		});
	});

	test("maps every failed operation to a truthful safe remediation", () => {
		const cases = [
			["create", "Agent setup failed", "restart"],
			["start", "Agent startup failed", "restart"],
			["stop", "Agent stop failed", "none"],
			["restart", "Agent restart failed", "restart"],
			["update", "Agent update failed", "none"],
			["runtime_switch", "Agent software change failed", "none"],
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
		const deployment = hostedDeploymentFixture({
			status: "starting",
			failure: {
				type: "https://api.clawdi.ai/problems/old_failure",
				title: "Old failure",
				status: 409,
				detail: "Old failure",
				code: "old_failure",
				retryable: false,
				conditionReason: "OldFailure",
				conditionMessage: "Old failure",
				observedGeneration: 0,
			},
		});
		expect(deploymentFailureProjection(deployment)).toBeNull();
	});

	test("surfaces a terminal provider operation before the resource summary catches up", () => {
		const operation: DeploymentOperation = {
			name: "operations/provider-failed",
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: "hdep_provider_failed",
				verb: "create",
				targetGeneration: 1,
				manifestETag: "manifest-provider-failed",
				createTime: "2026-07-27T00:00:00Z",
				updateTime: "2026-07-27T00:01:00Z",
			},
			done: true,
			error: {
				code: 5,
				message: "provider unavailable",
				details: [
					{
						"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
						type: "https://api.clawdi.ai/problems/provider-not-found",
						title: "Provider not found",
						status: 404,
						detail: "Provider unavailable",
						code: "provider_not_found",
						retryable: false,
						conditionReason: "ProviderNotFound",
						conditionMessage: "Provider unavailable",
						observedGeneration: 1,
					},
				],
			},
			response: null,
		};
		const deployment = hostedDeploymentFixture({
			id: "hdep_provider_failed",
			status: "starting",
			acceptedOperation: operation,
		});

		expect(deploymentFailurePresentation(deployment)).toMatchObject({
			title: "Provider configuration failed",
			reason: "The selected provider is no longer available in your Clawdi account.",
			remediation: { kind: "review_provider", label: "Fix provider" },
		});
	});

	test("does not classify unavailable status as a failure", () => {
		const deployment = hostedDeploymentFixture({ status: null });
		expect(deploymentFailureReason(deployment.resource.status)).toBeNull();
		expect(deploymentFailureProjection(deployment)).toBeNull();
	});
});

describe("deploymentMutationErrorMessage", () => {
	test("maps provider failures to provider recovery instead of billing copy", () => {
		const error = new BillingApiError(404, "provider_not_found", {
			detail: { code: "provider_not_found" },
		});
		const message = deploymentMutationErrorMessage(error);

		expect(message).toContain("selected provider is no longer available");
		expect(message).toContain("Choose Managed by Clawdi");
		expect(message).not.toContain("billing");
	});

	test("keeps an unconfirmed timeout distinct from a rejection", () => {
		expect(deploymentMutationErrorMessage(new BillingNetworkError("timeout"))).toContain(
			"couldn’t confirm whether the agent service accepted this change",
		);
	});

	test("maps the Basic slot entitlement to its actual recovery", () => {
		expect(
			deploymentMutationErrorMessage(
				new BillingApiError(403, "The Compute Basic free slot allows only one active deployment."),
			),
		).toBe(
			"Your free Basic compute slot is already in use. Stop that agent or choose paid compute, then try again.",
		);
	});
});
