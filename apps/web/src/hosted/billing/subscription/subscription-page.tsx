"use client";

import { AlertTriangle, CreditCard, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { HostedAgentControls } from "@/hosted/billing/agents/hosted-agent-controls";
import { BillingError, SubscriptionSkeleton } from "@/hosted/billing/components/state-views";
import { UsageMeter } from "@/hosted/billing/components/usage-meter";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { billingTermLabel, formatCentsCompact, formatCredits } from "@/hosted/billing/format";
import { usePlans, usePortal, useSubscription } from "@/hosted/billing/hooks";
import { ActivationCard } from "@/hosted/billing/subscription/activation-card";
import { ActivationRequirementCard } from "@/hosted/billing/subscription/activation-requirement-card";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import {
	isInDunning,
	shortDate,
	subscriptionStatusLabel,
	subscriptionStatusTone,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";

const DESCRIPTION = "Compute plans and AI Credits billing.";

export function SubscriptionPage() {
	const router = useRouter();
	const subscription = useSubscription();
	const plans = usePlans();
	const portal = usePortal();
	const runAction = useActionLock();
	const [term, setTerm] = useState(1);

	const perfPlan = useMemo(() => plans.data?.find((p) => p.price_cents > 0), [plans.data]);

	const sub = subscription.data ?? null;
	useEffect(() => {
		if (sub?.billing_term_months) setTerm(sub.billing_term_months);
	}, [sub?.billing_term_months]);
	const isPerformance = !!sub && !!perfPlan && sub.plan_slug === perfPlan.slug;

	async function deployPerformanceAgent() {
		router.push("/deploy");
	}

	async function manageBilling() {
		try {
			const res = await portal.mutateAsync({});
			if (res.url || res.portal_url) {
				window.location.href = res.url || res.portal_url;
				return;
			}
			toast.message("Billing portal unavailable", {
				description: res.message ?? "Please try again in a moment.",
			});
		} catch (e) {
			toast.error("Couldn’t open billing", { description: normalizeBillingError(e) });
		}
	}

	if (subscription.isLoading || plans.isLoading) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Compute" description={DESCRIPTION} />
				<SubscriptionSkeleton />
			</div>
		);
	}

	if (subscription.error) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Compute" description={DESCRIPTION} />
				<BillingError error={subscription.error} onRetry={() => subscription.refetch()} />
			</div>
		);
	}

	if (plans.error) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Compute" description={DESCRIPTION} />
				<BillingError
					error={plans.error}
					onRetry={() => plans.refetch()}
					title="Couldn’t load plans"
				/>
			</div>
		);
	}

	const ending = !!sub && (sub.cancel_at_period_end || !!sub.pending_downgrade_plan_slug);
	const pending = portal.isPending;
	const showUsage = !!sub && sub.budget_credits_total > 0;
	const summaryTitle = sub ? "Performance subscription" : "Free compute";

	return (
		<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
			<PageHeader title="Compute" description={DESCRIPTION} />

			<ActivationCard />

			<ActivationRequirementCard />

			<HostedAgentControls />

			{/* Dunning — payment failed; in a grace period. */}
			{sub && isInDunning(sub) ? (
				<Card data-hosted="true" className="border-destructive/40 bg-destructive-muted/30">
					<CardContent className="flex flex-col gap-3 sm:flex-row sm:items-start">
						<AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
						<div className="flex-1 space-y-3">
							<div className="space-y-1">
								<p className="font-medium">
									Payment failed — update your card for this Performance subscription
								</p>
								<p className="text-sm text-muted-foreground">
									We’ll keep retrying during a grace period. If it isn’t resolved, the affected
									agent falls back to Free when a Free slot is available, otherwise it stops.
								</p>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button size="sm" onClick={() => runAction(manageBilling)} disabled={pending}>
									{pending ? <Spinner /> : <CreditCard />} Update payment method
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>
			) : null}

			{/* Billing summary */}
			<Card data-hosted="true">
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle className="flex items-center gap-2">
							{isPerformance ? <Zap className="size-5 text-primary" aria-hidden /> : null}
							{summaryTitle}
						</CardTitle>
						{sub ? (
							<StatusBadge status={subscriptionStatusTone(sub)} withDot>
								{subscriptionStatusLabel(sub)}
							</StatusBadge>
						) : (
							<StatusBadge status="neutral">Free</StatusBadge>
						)}
					</div>
					<CardDescription>
						{isPerformance
							? "Each Performance subscription belongs to one hosted agent."
							: "Free compute is available for one active hosted agent. Deploy Performance when you need another paid agent."}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{sub ? (
						<dl className="grid gap-3 sm:grid-cols-2">
							<div>
								<dt className="text-xs text-muted-foreground">Billing</dt>
								<dd className="text-sm">
									{billingTermLabel(sub.billing_term_months)}
									{sub.billing_price_cents_snapshot
										? ` · ${formatCentsCompact(sub.billing_price_cents_snapshot)}`
										: ""}
								</dd>
							</div>
							<div>
								<dt className="text-xs text-muted-foreground">{ending ? "Ends" : "Renews"}</dt>
								<dd className="text-sm">{shortDate(sub.current_period_end)}</dd>
							</div>
							{sub.card_on_file && sub.card_last4 ? (
								<div>
									<dt className="text-xs text-muted-foreground">Card</dt>
									<dd className="flex items-center gap-1.5 text-sm">
										<CreditCard className="size-3.5" aria-hidden />
										{sub.card_brand ?? "Card"} •••• {sub.card_last4}
									</dd>
								</div>
							) : null}
						</dl>
					) : null}

					{/* Monthly AI Credits allowance with usage meter. */}
					{showUsage && sub ? (
						<div className="space-y-1.5">
							<div className="flex items-center justify-between text-sm">
								<span className="text-muted-foreground">Monthly AI Credits</span>
								<span className="tabular-nums">
									{formatCredits(sub.budget_credits_used ?? 0)} of{" "}
									{formatCredits(sub.budget_credits_total)} used
								</span>
							</div>
							<UsageMeter
								used={sub.budget_credits_used ?? 0}
								total={sub.budget_credits_total}
								label="Monthly AI Credits used"
							/>
							<p className="text-xs text-muted-foreground">
								Resets {shortDate(sub.next_allowance_reset_at ?? sub.current_period_end)}.
							</p>
						</div>
					) : null}

					{/* Pending downgrade / cancel notice */}
					{ending && sub ? (
						<div className="rounded-md border border-warning/40 bg-warning-muted/40 p-3 text-sm">
							This Performance subscription is scheduled to end on{" "}
							{shortDate(sub.pending_downgrade_effective_at ?? sub.current_period_end)}. Open
							billing to manage renewal.
						</div>
					) : null}

					<Separator />

					{/* Actions */}
					{isPerformance ? (
						<div className="space-y-3">
							<p className="text-sm text-muted-foreground">
								Performance is billed per hosted agent. Use billing to manage existing
								subscriptions, or deploy another Performance agent to create a new one.
							</p>
							<div className="flex flex-wrap gap-2">
								<Button onClick={() => runAction(manageBilling)} disabled={pending}>
									{pending ? <Spinner /> : <CreditCard />} Open billing
								</Button>
								<Button
									variant="outline"
									onClick={() => runAction(deployPerformanceAgent)}
									disabled={!perfPlan}
								>
									<Zap /> Deploy Performance agent
								</Button>
							</div>
						</div>
					) : (
						<div className="space-y-3">
							<div className="flex flex-wrap gap-2">
								<Button variant="outline" onClick={() => router.push("/deploy")}>
									Deploy Free agent
								</Button>
								<Button
									onClick={() => runAction(deployPerformanceAgent)}
									disabled={pending || !perfPlan}
								>
									{pending ? <Spinner /> : <Zap />} Deploy Performance agent
								</Button>
							</div>
						</div>
					)}
				</CardContent>
			</Card>

			{/* Compare plans — the former Pricing tab, folded into the deploy flow. */}
			<PlanComparison term={term} onTermChange={setTerm} />
		</div>
	);
}
