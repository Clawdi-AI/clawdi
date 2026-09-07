import type {
	HostedComputeSubscription,
	HostedDeploymentStatus,
	HostedFundingFact,
} from "@/hosted/billing/contracts";
import { KNOWN_DEPLOYMENT_STATUSES } from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

export const computeNow = Date.parse("2026-09-07T12:00:00Z");
export const computeFuture = "2027-07-15T12:00:00Z";
export const computePast = "2026-08-15T12:00:00Z";
export const computeRetry = "2026-09-08T12:00:00Z";
export const computeAvailable = {
	canCreateCloudAgents: true,
	plansLoading: false,
	performancePlanAvailable: true,
};
export const computePaid: HostedComputeSubscription = {
	subscription_id: 42,
	status: "active",
	funding_source: "stripe",
	price_cents: 2000,
	payment_state: "ok",
	currency: "usd",
	billing_term_months: 1,
	cancel_at_period_end: false,
	current_period_end: computeFuture,
};
const included: HostedComputeSubscription = {
	...computePaid,
	funding_source: null,
	price_cents: 0,
};

type Expected = {
	status: string | null;
	date?: readonly [label: string, at: string];
	action?: "upgrade" | "fix_payment" | "top_up" | "start_new";
	bannerRecovery?: boolean;
	transactions?: boolean;
};

const revokedFunding: HostedFundingFact = {
	fact_kind: "funding_revoked",
	commercial_revision: 1,
	funding_source: "stripe",
	reason: "canceled",
	prior_plan_slug: "compute_performance",
	occurred_at: computePast,
	emitted_at: computePast,
};

function state(
	name: string,
	subscription: Partial<HostedComputeSubscription> | null,
	expected: Expected,
	options: Parameters<typeof hostedDeploymentFixture>[0] = {},
) {
	return {
		name,
		deployment: hostedDeploymentFixture({
			agentId: "11111111-1111-4111-8111-111111111111",
			cloudEnvironments: { hermes: "11111111-1111-4111-8111-111111111111" },
			name: "Compute matrix",
			runtime: "hermes",
			currentPlanSlug: "compute_performance",
			computeSubscription: subscription === null ? null : { ...computePaid, ...subscription },
			resources:
				options?.currentPlanSlug === "compute_basic"
					? { vcpu: 2, memory_mib: 4096, disk_gib: 20 }
					: { vcpu: 4, memory_mib: 8192, disk_gib: 40 },
			...options,
		}),
		expected,
	};
}

// Status is an open string in the generated schema; these are the existing lifecycle resolver's cases.
const lifecycleCases = [
	["active", "Active", ["Next renewal", computeFuture]],
	["trialing", "Trial", ["Trial ends", computeFuture]],
	["canceling", "Canceling", ["Ends on", computeFuture]],
	["canceled", "Ended", ["Ended on", computePast]],
	["expired", "Expired", ["Expired on", computePast]],
	["incomplete_expired", "Expired", ["Expired on", computePast]],
	["incomplete", "Setup incomplete"],
	["paused", "Paused"],
	["past_due", "Past due"],
	["unpaid", "Unpaid"],
] as const;

// Exhaustive against the generated runtime union, separate from commercial state.
export const computeRuntimeLabels = {
	creating: "Starting",
	starting: "Starting",
	running: "Running",
	stopping: "Stopping",
	stopped: "Stopped",
	restarting: "Restarting",
	updating: "Updating",
	failed: "Failed",
	deleting: "Deleting",
	deleted: "Deleted",
} satisfies Record<HostedDeploymentStatus["summary_state"], string>;

export const computeOverviewCases = [
	...lifecycleCases.map(([status, label, date]) =>
		state(`subscription-${status}`, { status, canceled_at: computePast }, { status: label, date }),
	),
	state(
		"included-upgrade",
		included,
		{ status: "Included with your plan", action: "upgrade" },
		{ currentPlanSlug: "compute_basic", upgradeAvailable: true },
	),
	state(
		"paid-basic",
		{},
		{ status: "Active", date: ["Next renewal", computeFuture] },
		{ currentPlanSlug: "compute_basic" },
	),
	state(
		"wallet-active",
		{ funding_source: "wallet" },
		{ status: "Active", date: ["Next renewal", computeFuture] },
	),
	state("missing-subscription", null, { status: null }),
	state(
		"missing-subscription-recovery",
		null,
		{ status: null, bannerRecovery: true },
		{
			status: "stopped",
			desiredLifecycle: "stopped",
			fundingFact: revokedFunding,
			recoveryAction: "start_new",
		},
	),
	state(
		"included-after-refund",
		included,
		{ status: "Included with your plan", action: "start_new", transactions: true },
		{
			currentPlanSlug: "compute_basic",
			fundingFact: { ...revokedFunding, reason: "refunded" },
			recoveryAction: "start_new",
		},
	),
	state(
		"unknown-plan",
		{},
		{ status: "Active", date: ["Next renewal", computeFuture] },
		{ currentPlanSlug: "unrecognized-plan" },
	),
	state("unknown-funding", { funding_source: null, price_cents: null }, { status: "Active" }),
	state(
		"unknown-subscription",
		{ status: "unrecognized_subscription_status_".repeat(8) },
		{ status: "Status unavailable" },
	),
	state(
		"cancel-at-authority",
		{ cancel_at_period_end: true, cancel_at: computeRetry },
		{ status: "Canceling", date: ["Ends on", computeRetry] },
	),
	state(
		"scheduled-plan",
		{ pending_plan_slug: "compute_basic" },
		{ status: "Active", date: ["Next renewal", computeFuture] },
	),
	state(
		"requires-action",
		{
			payment_state: "requires_action",
			recovery_action: "fix_payment",
			next_payment_attempt_at: computeRetry,
		},
		{
			status: "Payment action required",
			date: ["Next payment attempt", computeRetry],
			action: "fix_payment",
		},
	),
	state(
		"invoice-recovery",
		{
			payment_state: "past_due",
			recovery_action: "fix_payment",
			latest_failed_invoice_hosted_url: "https://invoice.example.test/recover",
		},
		{ status: "Past due", action: "fix_payment" },
	),
	state(
		"wallet-recovery",
		{
			funding_source: "wallet",
			payment_state: "past_due",
			recovery_action: "top_up",
			next_payment_attempt_at: computeRetry,
		},
		{ status: "Past due", date: ["Next payment attempt", computeRetry], action: "top_up" },
	),
	state(
		"unpaid-authority",
		{ status: "unpaid", payment_state: "unpaid", recovery_blocked_reason: "authority_pending" },
		{ status: "Needs attention" },
	),
	state(
		"unpaid-finalized",
		{ status: "unpaid", payment_state: "unpaid", recovery_action: "start_new" },
		{ status: "Ended", action: "start_new" },
	),
	state(
		"canceled-recovery",
		{ status: "canceled", canceled_at: computePast, recovery_action: "start_new" },
		{ status: "Ended", date: ["Ended on", computePast], action: "start_new" },
	),
	state(
		"expired-recovery",
		{ status: "expired", current_period_end: computePast, recovery_action: "start_new" },
		{ status: "Ended", date: ["Expired on", computePast], action: "start_new" },
	),
	state(
		"incomplete-payment-pending",
		{ status: "incomplete", recovery_blocked_reason: "payment_pending" },
		{ status: "Payment processing" },
	),
	state(
		"paused-blocked",
		{ status: "paused", recovery_blocked_reason: "paused" },
		{ status: "Needs attention" },
	),
	state(
		"authority-pending",
		{ recovery_blocked_reason: "authority_pending" },
		{ status: "Updating subscription" },
	),
	...(["pending", "reconciling"] as const).map((command_state) =>
		state(
			`command-${command_state}`,
			{ actions: { cancel: null, resume: false, command_state } },
			{ status: "Updating subscription" },
		),
	),
	...([null, "invalid", computePast] as const).map((current_period_end, index) =>
		state(`renewal-unavailable-${index}`, { current_period_end }, { status: "Active" }),
	),
	...([null, "invalid", computeFuture] as const).map((canceled_at, index) =>
		state(`ended-unavailable-${index}`, { status: "canceled", canceled_at }, { status: "Ended" }),
	),
	...([null, "invalid", computePast] as const).map((next_payment_attempt_at, index) =>
		state(
			`retry-unavailable-${index}`,
			{ payment_state: "past_due", recovery_action: "fix_payment", next_payment_attempt_at },
			{ status: "Past due", action: "fix_payment" },
		),
	),
	...KNOWN_DEPLOYMENT_STATUSES.map((status) =>
		state(
			`runtime-${status}`,
			included,
			{
				status: "Included with your plan",
				action: status === "running" || status === "stopped" ? "upgrade" : undefined,
			},
			{ status, currentPlanSlug: "compute_basic", upgradeAvailable: true },
		),
	),
	state(
		"runtime-unavailable",
		included,
		{ status: "Included with your plan" },
		{ status: null, currentPlanSlug: "compute_basic", upgradeAvailable: true },
	),
	state(
		"failed-payment-recovery",
		{ payment_state: "past_due", recovery_action: "fix_payment" },
		{ status: "Past due", action: "fix_payment" },
		{ status: "failed" },
	),
	...(["deleting", "deleted"] as const).map((status) =>
		state(
			`${status}-payment-recovery`,
			{ payment_state: "past_due", recovery_action: "fix_payment" },
			{ status: "Past due" },
			{ status },
		),
	),
	state(
		"deleted-no-projection",
		{},
		{ status: "Active", date: ["Next renewal", computeFuture] },
		{ status: "deleted", cloudEnvironments: {} },
	),
];

const degraded = state(
	"runtime-degraded",
	included,
	{ status: "Included with your plan" },
	{ currentPlanSlug: "compute_basic", upgradeAvailable: true },
);
if (!degraded.deployment.resource.status) throw new Error("Degraded fixture requires a status");
degraded.deployment.resource.status.conditions.push({
	type: "Degraded",
	status: "True",
	reason: "RuntimeHealthDegraded",
	message: "Runtime unavailable",
	observedGeneration: 1,
	lastTransitionTime: "2026-09-07T12:00:00Z",
});
computeOverviewCases.push(degraded);

computeOverviewCases.push(
	state(
		"accepted-plan-change",
		included,
		{ status: "Updating subscription" },
		{
			currentPlanSlug: "compute_basic",
			upgradeAvailable: true,
			acceptedOperation: {
				name: "operations/plan-change",
				done: false,
				metadata: {
					"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
					deploymentId: "dep_test",
					verb: "plan_change",
					targetGeneration: 2,
					manifestETag: "etag",
					createTime: "2026-09-07T12:00:00Z",
					updateTime: "2026-09-07T12:00:00Z",
				},
			},
		},
	),
);
