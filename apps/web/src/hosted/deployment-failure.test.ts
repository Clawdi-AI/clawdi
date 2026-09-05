import { describe, expect, test } from "bun:test";
import type { DeploymentOperation } from "@/hosted/billing/contracts";
import {
	BillingApiError,
	BillingNetworkError,
	DeploymentConflictError,
} from "@/hosted/billing/errors";
import {
	deploymentFailurePresentation,
	deploymentFailureProjection,
	deploymentFailureReason,
	deploymentMutationErrorMessage,
	operationCancelErrorMessage,
} from "@/hosted/deployment-failure";
import type { DeploymentOperationVerb } from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

function failedOperation(verb: DeploymentOperationVerb): DeploymentOperation {
	return {
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
		done: true,
		error: {
			code: 13,
			message: "operation failed",
			details: [
				{
					"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
					type: "https://api.clawdi.ai/problems/operation-failed",
					title: "Operation failed",
					status: 500,
					detail: "Internal operation detail",
					code: "operation_failed",
					retryable: true,
					conditionReason: "OperationFailed",
					conditionMessage: "Internal operation detail",
					observedGeneration: 2,
				},
			],
		},
		response: null,
	};
}

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

	test("uses an explicit status phase without borrowing a pending operation verb", () => {
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
			failedVerb: null,
			retryable: false,
			code: "operation_aborted",
		});
		expect(deploymentFailurePresentation(deployment)).toEqual({
			reason:
				"The Clawdi service could not confirm the plan change. Your plan was not changed and you were not charged.",
			failedVerb: null,
			retryable: false,
			code: "operation_aborted",
			title: "Plan change failed",
			description: "Get a fresh quote and confirm the price before trying again.",
			status: { kind: "failed", label: "Failed", tone: "destructive" },
			remediation: {
				kind: "review_plan_change",
				label: "Get fresh quote",
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
				acceptedOperation: failedOperation(verb),
			});
			const presentation = deploymentFailurePresentation(deployment);

			expect(presentation?.title).toBe(title);
			expect(presentation?.remediation.kind).toBe(remediationKind);
		}
	});

	test("keeps a successful restart separate from a later runtime health failure", () => {
		const running = hostedDeploymentFixture({ id: "hdep_runtime_degraded" });
		const deployment = hostedDeploymentFixture({
			id: "hdep_runtime_degraded",
			status: "failed",
			acceptedOperation: {
				name: "operations/restart-succeeded",
				metadata: {
					"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
					deploymentId: "hdep_runtime_degraded",
					verb: "restart",
					targetGeneration: 2,
					manifestETag: "manifest-restarted",
					createTime: "2026-08-01T11:26:54Z",
					updateTime: "2026-08-01T11:27:59Z",
				},
				done: true,
				response: {
					"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
					deployment: running.resource,
				},
			},
			failure: {
				type: "https://api.clawdi.ai/problems/runtime-readiness-timeout",
				title: "Runtime readiness timed out",
				status: 504,
				detail: "runtime apply failed: internal prerequisite output",
				code: "runtime_readiness_timeout",
				phase: "reconcile",
				retryable: true,
				conditionReason: "RuntimeReadinessTimeout",
				conditionMessage: "internal runtime health error",
				observedGeneration: 2,
			},
		});

		expect(deploymentFailureProjection(deployment)).toEqual({
			reason: "Clawdi is checking this Agent. Open Agent settings for details.",
			failedVerb: null,
			retryable: true,
			code: "runtime_readiness_timeout",
		});
		expect(deploymentFailurePresentation(deployment)).toMatchObject({
			title: "Temporarily unavailable",
			failedVerb: null,
			description: "Clawdi is checking this Agent. Open Agent settings for details.",
			status: {
				kind: "runtime_unavailable",
				label: "Temporarily unavailable",
				tone: "warning",
			},
			remediation: { kind: "none", label: null },
		});
		expect(deploymentFailurePresentation(deployment)?.title).not.toContain("restart");
	});

	test("attributes restart wording only to a terminal restart operation error", () => {
		const deployment = hostedDeploymentFixture({
			status: "failed",
			acceptedOperation: failedOperation("restart"),
		});

		expect(deploymentFailureProjection(deployment)?.failedVerb).toBe("restart");
		expect(deploymentFailurePresentation(deployment)).toMatchObject({
			title: "Agent restart failed",
			status: { kind: "failed", label: "Failed", tone: "destructive" },
			remediation: { kind: "restart", label: "Retry restart" },
		});
	});

	test("prioritizes customer-actionable codes over a broad reconcile phase", () => {
		const cases = [
			{
				code: "runtime_readiness_timeout",
				title: "Temporarily unavailable",
				reason: "Clawdi is checking this Agent. Open Agent settings for details.",
			},
			{
				code: "operation_aborted",
				title: "Agent action failed",
				reason: "The Clawdi service could not complete this request.",
			},
		] as const;

		for (const item of cases) {
			const deployment = hostedDeploymentFixture({
				status: "failed",
				failure: {
					type: `https://api.clawdi.ai/problems/${item.code}`,
					title: "Internal reconcile failure",
					status: 409,
					detail: "internal controller detail",
					code: item.code,
					phase: "reconcile",
					retryable: false,
					conditionReason: "ReconcileFailed",
					conditionMessage: "internal controller detail",
					observedGeneration: 2,
				},
			});
			const presentation = deploymentFailurePresentation(deployment);

			expect(presentation).toMatchObject({
				title: item.title,
				reason: item.reason,
			});
		}
	});

	test("never maps codes outside the pinned lifecycle problem set to provider or wallet copy", () => {
		const deployment = hostedDeploymentFixture({
			status: "failed",
			failure: {
				type: "https://api.clawdi.ai/problems/provider-not-found",
				title: "Provider not found",
				status: 404,
				detail: "Provider unavailable",
				code: "provider_not_found",
				phase: "reconcile",
				retryable: false,
				conditionReason: "ProviderNotFound",
				conditionMessage: "Provider unavailable",
				observedGeneration: 2,
			},
		});
		const presentation = deploymentFailurePresentation(deployment);
		const projection = deploymentFailureProjection(deployment);

		expect(projection?.code).toBe("provider_not_found");
		expect(projection?.reason).toBe("The Clawdi service could not complete this request.");
		expect(presentation?.title).not.toContain("Provider configuration failed");
		expect(presentation?.remediation.kind).not.toBe("review_provider");
		expect(presentation?.description).not.toContain("Wallet");
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

	test("surfaces a terminal operation failure before the resource summary catches up", () => {
		const operation: DeploymentOperation = {
			name: "operations/create-failed",
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: "hdep_create_failed",
				verb: "create",
				targetGeneration: 1,
				manifestETag: "manifest-create-failed",
				createTime: "2026-07-27T00:00:00Z",
				updateTime: "2026-07-27T00:01:00Z",
			},
			done: true,
			error: {
				code: 13,
				message: "operation failed",
				details: [
					{
						"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
						type: "https://api.clawdi.ai/problems/operation_aborted",
						title: "Deployment operation was aborted",
						status: 409,
						detail: "Operation aborted",
						code: "operation_aborted",
						retryable: false,
						conditionReason: "OperationAborted",
						conditionMessage: "Operation aborted",
						observedGeneration: 1,
					},
				],
			},
			response: null,
		};
		const deployment = hostedDeploymentFixture({
			id: "hdep_create_failed",
			status: "starting",
			acceptedOperation: operation,
		});

		expect(deploymentFailurePresentation(deployment)).toMatchObject({
			title: "Agent setup failed",
			failedVerb: "create",
			remediation: { kind: "restart", label: "Retry startup" },
		});
	});

	test("does not classify unavailable status as a failure", () => {
		const deployment = hostedDeploymentFixture({ status: null });
		expect(deploymentFailureReason(deployment.resource.status)).toBeNull();
		expect(deploymentFailureProjection(deployment)).toBeNull();
	});
});

describe("deploymentMutationErrorMessage", () => {
	test("funding revocation stays actionable through conflict wrapping and failed operations", () => {
		const problem = {
			"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails" as const,
			type: "https://api.clawdi.ai/problems/funding-revoked-after-accept",
			title: "Internal funding fence",
			detail: "Internal funding fence",
			status: 409,
			code: "funding_revoked_after_accept",
			conditionReason: "FundingRevoked",
			conditionMessage: "Internal resource details",
			observedGeneration: 2,
		};
		const error = new BillingApiError(409, "Internal funding fence", problem);
		const message = deploymentMutationErrorMessage(error);
		expect(message).toContain("Open Agent settings and choose a subscription");
		expect(message).not.toMatch(/internal|retry|container|volume|disk/i);
		expect(deploymentMutationErrorMessage(new DeploymentConflictError({ cause: error }))).toBe(
			message,
		);
		const operation = failedOperation("start");
		const presentation = deploymentFailurePresentation(
			hostedDeploymentFixture({
				status: "stopped",
				acceptedOperation: {
					...operation,
					error: { code: 9, message: "Internal funding fence", details: [problem] },
				},
			}),
		);
		expect(presentation).toMatchObject({
			title: "Subscription required",
			reason: message,
			description: message,
			remediation: { kind: "none", label: null },
		});
	});

	test("does not map never-emitted provider codes to provider recovery copy", () => {
		const error = new BillingApiError(404, "provider_not_found", {
			detail: { code: "provider_not_found" },
		});
		const message = deploymentMutationErrorMessage(error);

		expect(message).toBe(
			"This agent is no longer available. Return to Agents and refresh the list.",
		);
		expect(message).not.toContain("selected provider is no longer available");
	});

	test("keeps an unconfirmed timeout distinct from a rejection", () => {
		expect(deploymentMutationErrorMessage(new BillingNetworkError("timeout"))).toContain(
			"couldn’t confirm whether the agent service accepted this change",
		);
	});

	test("falls back to the account-level 403 copy instead of a literal detail string", () => {
		expect(
			deploymentMutationErrorMessage(
				new BillingApiError(403, "The Compute Basic free slot allows only one active deployment."),
			),
		).toBe("Your Clawdi account can’t change this agent. Ask the agent owner to update it.");
	});
});

describe("cancelled operation presentation", () => {
	function cancelledOperation(verb: DeploymentOperationVerb): DeploymentOperation {
		return {
			...failedOperation(verb),
			name: `operations/${verb}-cancelled`,
			error: {
				code: 1,
				message: "Operation was cancelled",
				details: [
					{
						"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
						type: "https://api.clawdi.ai/problems/operation-cancelled",
						title: "Deployment operation was cancelled",
						status: 409,
						detail: "Cancellation committed a compensating desired-state generation.",
						code: "operation_cancelled",
						retryable: false,
						conditionReason: "OperationCancelled",
						conditionMessage: "Cancellation committed a compensating desired-state generation.",
						observedGeneration: 2,
					},
				],
			},
		};
	}

	test("presents a user-cancelled delete as cancelled, not failed, with no retry", () => {
		const presentation = deploymentFailurePresentation(
			hostedDeploymentFixture({
				status: "running",
				acceptedOperation: cancelledOperation("delete"),
			}),
		);

		expect(presentation).toMatchObject({
			title: "Agent deletion cancelled",
			status: { kind: "cancelled", label: "Cancelled", tone: "neutral" },
			remediation: { kind: "none", label: null },
		});
		expect(presentation?.description).toContain("was stopped before it completed");
	});

	test("labels every cancelled operation verb without inventing a retry", () => {
		for (const verb of ["create", "start", "restart", "update", "plan_change"] as const) {
			const presentation = deploymentFailurePresentation(
				hostedDeploymentFixture({
					status: "starting",
					acceptedOperation: cancelledOperation(verb),
				}),
			);
			expect(presentation?.title).toContain("cancelled");
			expect(presentation?.remediation.kind).toBe("none");
		}
	});

	test("does not claim failure for a cancelled operation", () => {
		const presentation = deploymentFailurePresentation(
			hostedDeploymentFixture({
				status: "running",
				acceptedOperation: cancelledOperation("start"),
			}),
		);
		expect(presentation?.status.kind).toBe("cancelled");
		expect(presentation?.title).not.toContain("failed");
	});
});

describe("operationCancelErrorMessage", () => {
	test("explains a completed-change race instead of the generic mutation copy", () => {
		const error = new BillingApiError(409, "Deployment operation was cancelled", {
			detail: { code: "operation_cancelled" },
		});
		expect(operationCancelErrorMessage(error)).toBe(
			"This change already finished before cancellation could be applied.",
		);
	});

	test("explains an idempotency-key reuse without leaking the key", () => {
		const error = new BillingApiError(409, "Deployment idempotency key was reused", {
			detail: { code: "idempotency_key_reused" },
		});
		expect(operationCancelErrorMessage(error)).toBe(
			"This cancellation was already requested. Check the latest status, then try again.",
		);
	});

	test("falls back to the shared mutation copy for other rejections", () => {
		const error = new BillingApiError(404, "Operation not found");
		expect(operationCancelErrorMessage(error)).toBe(
			"This agent is no longer available. Return to Agents and refresh the list.",
		);
	});
});
