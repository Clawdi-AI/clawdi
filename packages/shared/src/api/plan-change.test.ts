import { describe, expect, test } from "bun:test";
import type { components } from "./deploy.generated";
import {
	type ComputePlanChangeKind,
	planChangeOperationId,
	planChangeOperationOutcome,
	readPlanChangeOperation,
} from "./plan-change";

const NOW = "2026-10-16T00:00:00Z";

function operation(
	state: components["schemas"]["ComputePlanChangeProgress"]["state"],
	{
		done = false,
		error = null,
		changeKind = "immediate_upgrade",
		billingEffect = changeKind === "funding_source_switch"
			? "future_renewals"
			: changeKind === "scheduled_downgrade"
				? "period_end"
				: "immediate_proration",
		targetPlanSlug = changeKind === "funding_source_switch"
			? "compute_basic"
			: "compute_performance",
		response,
	}: {
		done?: boolean;
		error?: unknown;
		changeKind?: ComputePlanChangeKind;
		billingEffect?: string;
		targetPlanSlug?: string;
		response?: unknown;
	} = {},
) {
	return {
		name: "operations/plan-change-1",
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_test",
			verb: "plan_change",
			planChange: {
				"@type": "type.googleapis.com/clawdi.v2.ComputePlanChangeProgress",
				operationId: "plan-change-1",
				subscriptionId: 42,
				fundingSource: "wallet",
				changeKind,
				billingEffect,
				sourcePlanSlug: "compute_basic",
				targetPlanSlug,
				targetBillingTermMonths: 1,
				state,
				effectiveAt: NOW,
			},
		},
		done,
		error,
		response:
			response !== undefined
				? response
				: done && error === null
					? {
							"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
							deployment: { id: "hdep_test" },
						}
					: null,
	};
}

function outcome(value: unknown) {
	const parsed = readPlanChangeOperation(value);
	return parsed ? planChangeOperationOutcome(parsed) : null;
}

describe("plan-change operation reading (Web's strict contract)", () => {
	test("an accepted change still running is pending", () => {
		expect(outcome(operation("awaiting_payment"))).toEqual({
			kind: "pending",
			operationName: "operations/plan-change-1",
		});
	});

	test("an upgrade completes and a downgrade is scheduled", () => {
		expect(outcome(operation("complete", { done: true }))).toEqual({
			kind: "settled",
			operationName: "operations/plan-change-1",
			result: {
				kind: "complete",
				operationName: "operations/plan-change-1",
				effectiveAt: NOW,
				changeKind: "immediate_upgrade",
				billingEffect: "immediate_proration",
				fundingSource: "wallet",
			},
		});
		expect(
			outcome(
				operation("scheduled", {
					done: true,
					changeKind: "scheduled_downgrade",
					targetPlanSlug: "compute_basic",
				}),
			),
		).toMatchObject({ kind: "settled", result: { kind: "scheduled" } });
	});

	test("a failed terminal state keeps hosted's problem and the change context", () => {
		const problem = {
			status: 409,
			detail: "payment_method_required",
			code: "payment_method_required",
		};
		expect(
			outcome(
				operation("failed", {
					done: true,
					changeKind: "funding_source_switch",
					error: { code: 9, message: "A card is required.", details: [{ "@type": "x" }, problem] },
				}),
			),
		).toEqual({
			kind: "failed",
			operationName: "operations/plan-change-1",
			changeKind: "funding_source_switch",
			fundingSource: "wallet",
			problem,
		});
		expect(
			outcome(operation("failed", { done: true, error: { code: 9, message: "Failed" } })),
		).toMatchObject({ kind: "failed", problem: null });
	});

	test("contradictory or incomplete operations are invalid, never success", () => {
		const missingFunding = operation("complete", { done: true });
		Reflect.deleteProperty(missingFunding.metadata.planChange, "fundingSource");
		expect(readPlanChangeOperation(missingFunding)).toBeNull();
		expect(readPlanChangeOperation({ ...operation("complete"), metadata: undefined })).toBeNull();
		expect(
			readPlanChangeOperation(
				operation("complete", {
					done: true,
					response: { "@type": "type.googleapis.com/google.protobuf.Empty" },
				}),
			),
		).toBeNull();
		for (const invalid of [
			// A payment-source switch must keep the plan and affect future renewals only.
			operation("complete", {
				done: true,
				changeKind: "funding_source_switch",
				billingEffect: "immediate_proration",
			}),
			operation("complete", {
				done: true,
				changeKind: "funding_source_switch",
				targetPlanSlug: "compute_performance",
			}),
			// Running operations carry neither an error nor a response.
			operation("awaiting_payment", { error: { code: 9, message: "x" } }),
			// A finished operation carries exactly one of them, for this deployment.
			operation("complete", {
				done: true,
				error: { code: 9 },
				response: {
					"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
					deployment: { id: "hdep_test" },
				},
			}),
			operation("complete", {
				done: true,
				response: {
					"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
					deployment: { id: "hdep_other" },
				},
			}),
			// A downgrade settles only as scheduled; anything else only as complete.
			operation("complete", {
				done: true,
				changeKind: "scheduled_downgrade",
				targetPlanSlug: "compute_basic",
			}),
			operation("awaiting_projection", { done: true }),
		])
			expect(outcome(invalid)).toEqual({ kind: "invalid" });
	});

	test("operation ids come only from operations/{id} names", () => {
		expect(planChangeOperationId("operations/plan-change-1")).toBe("plan-change-1");
		expect(planChangeOperationId("operations/")).toBeNull();
		expect(planChangeOperationId("plan-change-1")).toBeNull();
	});
});
