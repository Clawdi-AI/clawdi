import { describe, expect, test } from "bun:test";
import {
	computeSubscriptionActionRequest,
	scheduledPlanCancellationNotice,
	subscriptionMutationNotice,
} from "./compute-subscription-action-list";

describe("scheduled plan cancellation execution", () => {
	test("uses the exact public target and never reports pending work as success", () => {
		expect(
			computeSubscriptionActionRequest({ kind: "deployment", deploymentId: "hdep_agent" }),
		).toEqual({ deployment_id: "hdep_agent" });
		expect(
			computeSubscriptionActionRequest({
				kind: "subscription",
				subscriptionId: "csub_account",
				deploymentId: null,
			}),
		).toEqual({ subscription_id: "csub_account" });

		const result = {
			status: "active",
			billing_term_months: 1,
			cancel_at_period_end: false,
		};
		expect(scheduledPlanCancellationNotice({ ...result, action_state: "removed" })).toMatchObject({
			kind: "success",
			title: "Scheduled plan change canceled",
		});
		for (const actionState of ["pending", "reconciling"] as const) {
			expect(
				scheduledPlanCancellationNotice({ ...result, action_state: actionState }),
			).toMatchObject({ kind: "info" });
		}
	});
});

test("subscription mutations only confirm completed cancellation or renewal", () => {
	const result = {
		status: "active",
		billing_term_months: 1,
		cancel_at_period_end: true,
		action_state: null,
		message: "Display-only service text",
	};
	expect(subscriptionMutationNotice(result, "cancel")).toMatchObject({
		kind: "success",
		title: "Cancellation scheduled",
	});
	expect(
		subscriptionMutationNotice(
			{ ...result, status: "canceled", cancel_at_period_end: false },
			"cancel",
		),
	).toMatchObject({ kind: "success", title: "Subscription canceled" });
	expect(
		subscriptionMutationNotice({ ...result, cancel_at_period_end: false }, "resume"),
	).toMatchObject({ kind: "success", title: "Subscription renewal restored" });
	for (const action of ["cancel", "resume"] as const) {
		for (const action_state of ["pending", "reconciling"] as const) {
			expect(
				subscriptionMutationNotice(
					{
						...result,
						status: action === "cancel" ? "canceled" : "active",
						cancel_at_period_end: false,
						action_state,
					},
					action,
					"Confirmed",
				),
			).toMatchObject({
				kind: "info",
				description: "Check the latest subscription details in a moment before trying again.",
			});
		}
	}
	expect(subscriptionMutationNotice(result, "resume").kind).toBe("info");
	expect(
		subscriptionMutationNotice({ ...result, cancel_at_period_end: false }, "cancel").kind,
	).toBe("info");
});
