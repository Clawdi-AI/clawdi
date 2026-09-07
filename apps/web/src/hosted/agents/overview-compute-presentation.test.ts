import { describe, expect, test } from "bun:test";
import type { HostedComputeSubscription } from "@/hosted/billing/contracts";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import { formatShortDate } from "@/lib/format";
import { overviewComputePresentation } from "./overview-compute-presentation";

const now = Date.parse("2026-09-07T12:00:00Z");
const future = "2027-07-15T00:00:00Z";
const retryAt = "2026-09-08T12:00:00Z";
const past = "2026-08-15T00:00:00Z";
const available = {
	canCreateCloudAgents: true,
	plansLoading: false,
	performancePlanAvailable: true,
};
const paid: HostedComputeSubscription = {
	status: "active",
	funding_source: "stripe",
	price_cents: 900,
	payment_state: "ok",
	currency: "usd",
	billing_term_months: 1,
	cancel_at_period_end: false,
	current_period_end: future,
};
const included = { ...paid, funding_source: null, price_cents: 0 };
const view = (subscription: HostedComputeSubscription | null) =>
	overviewComputePresentation(
		hostedDeploymentFixture({ computeSubscription: subscription, upgradeAvailable: true }),
		available,
		now,
	);

describe("overview Compute presentation", () => {
	test("distinguishes included access from a paid subscription without inventing charges", () => {
		expect(view(included)).toMatchObject({
			planLabel: "Basic plan",
			subscription: { label: null, value: "Included with your plan" },
			date: null,
			action: { kind: "upgrade", label: "Upgrade" },
		});
		expect(view(paid)).toMatchObject({
			subscription: { label: "Subscription", value: "Active" },
			date: { label: "Next renewal", value: formatShortDate(future) },
			action: null,
		});
		expect(view(null)).toMatchObject({ subscription: null, date: null, action: null });
		expect(
			overviewComputePresentation(
				hostedDeploymentFixture({ currentPlanSlug: "unrecognized" }),
				available,
				now,
			).planLabel,
		).toBe("Plan unavailable");
	});

	test.each([
		{
			changes: { cancel_at_period_end: true, cancel_at: "2027-01-15T00:00:00Z" },
			label: "Ends on",
			at: "2027-01-15T00:00:00Z",
		},
		{
			changes: {
				status: "trialing",
				actions: { cancel: "end_trial", resume: false, command_state: null },
			},
			label: "Trial ends",
			at: future,
		},
		{ changes: { status: "canceled", canceled_at: past }, label: "Ended on", at: past },
		{ changes: { status: "expired", current_period_end: past }, label: "Expired on", at: past },
	] satisfies { changes: Partial<HostedComputeSubscription>; label: string; at: string }[])(
		"uses authoritative dates for $label",
		({ changes, label, at }) => {
			expect(view({ ...paid, ...changes }).date).toEqual({ label, value: formatShortDate(at) });
		},
	);

	test("never substitutes a renewal date for a payment attempt", () => {
		const recovery: HostedComputeSubscription = {
			...paid,
			payment_state: "past_due",
			recovery_action: "fix_payment",
		};
		expect(view(recovery)).toMatchObject({
			subscription: { value: "Past due" },
			date: null,
			action: { kind: "fix_payment" },
		});
		expect(view({ ...recovery, next_payment_attempt_at: retryAt }).date).toEqual({
			label: "Next payment attempt",
			value: formatShortDate(retryAt),
		});
		expect(view({ ...recovery, next_payment_attempt_at: past }).date).toBeNull();
		expect(
			view({ ...recovery, funding_source: "wallet", recovery_action: "top_up" }).action,
		).toEqual({ kind: "top_up", label: "Top up" });
		expect(
			view({ ...recovery, status: "canceled", recovery_action: "start_new", canceled_at: past }),
		).toMatchObject({
			date: { label: "Ended on" },
			action: { kind: "start_new", label: "Manage" },
		});
	});

	test.each([
		{ current_period_end: null },
		{ current_period_end: "invalid" },
		{ funding_source: null, price_cents: null },
		{ current_period_end: past },
		{ status: "unknown" },
		{ status: "canceled", canceled_at: null },
		{ status: "canceled", canceled_at: future },
		{ status: "expired", current_period_end: future },
		{ recovery_blocked_reason: "authority_pending" },
		{ recovery_blocked_reason: "payment_pending" },
		{ actions: { cancel: null, resume: false, command_state: "pending" } },
	] satisfies Partial<HostedComputeSubscription>[])(
		"omits unconfirmed or invalid dates (%j)",
		(changes) => {
			expect(view({ ...paid, ...changes }).date).toBeNull();
		},
	);

	test("keeps upgrade gates in one place while leaving payment recovery available", () => {
		for (const status of [null, "failed", "restarting", "updating", "deleted"] as const) {
			expect(
				overviewComputePresentation(
					hostedDeploymentFixture({
						status,
						computeSubscription: included,
						upgradeAvailable: true,
					}),
					available,
					now,
				).action,
			).toBeNull();
		}
		for (const status of ["running", "stopped"] as const) {
			expect(
				overviewComputePresentation(
					hostedDeploymentFixture({
						status,
						computeSubscription: included,
						upgradeAvailable: true,
					}),
					available,
					now,
				).action?.kind,
			).toBe("upgrade");
		}
		for (const limits of [
			{ canCreateCloudAgents: false },
			{ plansLoading: true },
			{ performancePlanAvailable: false },
		]) {
			expect(
				overviewComputePresentation(
					hostedDeploymentFixture({ computeSubscription: included, upgradeAvailable: true }),
					{ ...available, ...limits },
					now,
				).action,
			).toBeNull();
		}
		for (const changes of [
			{ cancel_at_period_end: true },
			{ pending_plan_slug: "compute_performance" },
			{ recovery_blocked_reason: "authority_pending" },
			{ status: "trialing" },
			{ status: "canceled" },
		] satisfies Partial<HostedComputeSubscription>[])
			expect(view({ ...included, ...changes }).action).toBeNull();
		const recovering = hostedDeploymentFixture({
			status: "failed",
			computeSubscription: { ...paid, payment_state: "past_due", recovery_action: "fix_payment" },
		});
		expect(
			overviewComputePresentation(recovering, { ...available, canCreateCloudAgents: false }, now)
				.action?.kind,
		).toBe("fix_payment");
	});

	test("suppresses dates and shortcuts while an accepted plan change is pending", () => {
		const deployment = hostedDeploymentFixture({
			computeSubscription: included,
			upgradeAvailable: true,
		});
		deployment.accepted_operation = {
			name: "operations/plan-change",
			done: false,
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: deployment.resource.id,
				verb: "plan_change",
				targetGeneration: 2,
				manifestETag: "etag",
				createTime: past,
				updateTime: past,
			},
		};
		expect(overviewComputePresentation(deployment, available, now)).toMatchObject({
			subscription: { value: "Updating subscription" },
			date: null,
			action: null,
		});
	});
});
