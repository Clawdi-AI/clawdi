"use client";

import { AlertTriangle, CreditCard, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { HostedAgentControls } from "@/hosted/billing/agents/hosted-agent-controls";
import { BillingError, SubscriptionSkeleton } from "@/hosted/billing/components/state-views";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import { UsageMeter } from "@/hosted/billing/components/usage-meter";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { billingTermLabel, formatCentsCompact, formatCredits } from "@/hosted/billing/format";
import { useCheckout, usePlans, usePortal, useSubscription } from "@/hosted/billing/hooks";
import { ActivationCard } from "@/hosted/billing/subscription/activation-card";
import { ActivationRequirementCard } from "@/hosted/billing/subscription/activation-requirement-card";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import {
	handlePortalResult,
	isInDunning,
	planOffers,
	shortDate,
	subscriptionStatusLabel,
	subscriptionStatusTone,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";

const DESCRIPTION = "Your Clawdi Compute plan.";

export function SubscriptionPage() {
	const subscription = useSubscription();
	const plans = usePlans();
	const checkout = useCheckout();
	const portal = usePortal();
	const runAction = useActionLock();
	const [term, setTerm] = useState(1);

	const freePlan = useMemo(() => plans.data?.find((p) => p.price_cents === 0), [plans.data]);
	const perfPlan = useMemo(() => plans.data?.find((p) => p.price_cents > 0), [plans.data]);

	const sub = subscription.data ?? null;
	const perfOffers = perfPlan ? planOffers(perfPlan) : [];
	useEffect(() => {
		if (sub?.billing_term_months) setTerm(sub.billing_term_months);
	}, [sub?.billing_term_months]);
	const isPerformance = !!sub && !!perfPlan && sub.plan_slug === perfPlan.slug;

	async function upgrade() {
		if (!perfPlan) return;
		try {
			// Wallet users already hold an active compute_free subscription, so an
			// upgrade is a plan CHANGE via the portal — the backend rejects
			// /checkout ("already have an active subscription"). Only a user with
			// no subscription at all goes through checkout.
			if (sub) {
				handlePortalResult(
					await portal.mutateAsync({
						target_plan_slug: perfPlan.slug,
						target_billing_term_months: term,
						confirm_upgrade: true,
					}),
					() => subscription.refetch(),
				);
				return;
			}
			const res = await checkout.mutateAsync({
				plan_slug: perfPlan.slug,
				billing_term_months: term,
				collection_method: "charge_automatically",
				ui_mode: "hosted",
			});
			const url = res.action_url || res.checkout_url || res.invoice_url;
			if (url) window.location.href = url;
			else toast.error("Couldn’t start checkout", { description: "Please try again." });
		} catch (e) {
			toast.error("Couldn’t start upgrade", { description: normalizeBillingError(e) });
		}
	}

	async function downgradeToFree() {
		if (!freePlan) return;
		try {
			handlePortalResult(
				await portal.mutateAsync({ target_plan_slug: freePlan.slug, confirm_upgrade: true }),
				() => subscription.refetch(),
			);
		} catch (e) {
			toast.error("Couldn’t schedule downgrade", { description: normalizeBillingError(e) });
		}
	}

	async function changeTerm() {
		try {
			handlePortalResult(
				await portal.mutateAsync({ target_billing_term_months: term, confirm_upgrade: true }),
				() => subscription.refetch(),
			);
		} catch (e) {
			toast.error("Couldn’t change billing term", { description: normalizeBillingError(e) });
		}
	}

	async function manageBilling() {
		try {
			const res = await portal.mutateAsync({ confirm_upgrade: false });
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
				<PageHeader title="Plan" description={DESCRIPTION} />
				<SubscriptionSkeleton />
			</div>
		);
	}

	if (subscription.error) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Plan" description={DESCRIPTION} />
				<BillingError error={subscription.error} onRetry={() => subscription.refetch()} />
			</div>
		);
	}

	if (plans.error) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Plan" description={DESCRIPTION} />
				<BillingError
					error={plans.error}
					onRetry={() => plans.refetch()}
					title="Couldn’t load plans"
				/>
			</div>
		);
	}

	const ending = !!sub && (sub.cancel_at_period_end || !!sub.pending_downgrade_plan_slug);
	const pending = portal.isPending || checkout.isPending;
	const showUsage = !!sub && sub.budget_credits_total > 0;

	return (
		<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
			<PageHeader title="Plan" description={DESCRIPTION} />

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
									Payment failed — update your card to stay on Performance
								</p>
								<p className="text-sm text-muted-foreground">
									We’ll keep retrying during a grace period. If it isn’t resolved, you’ll move to
									Free automatically — no downtime, your agent keeps running. Restore payment any
									time to return to Performance.
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

			{/* Current plan */}
			<Card data-hosted="true">
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle className="flex items-center gap-2">
							{isPerformance ? <Zap className="size-5 text-primary" aria-hidden /> : null}
							{isPerformance ? "Performance" : "Free"}
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
							? "Higher burst, dual engines, and a monthly AI Credits grant."
							: "Always-on compute at $0. Upgrade any time for more power."}
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
							Performance is scheduled to end on{" "}
							{shortDate(sub.pending_downgrade_effective_at ?? sub.current_period_end)}. Open
							billing to manage renewal.
						</div>
					) : null}

					<Separator />

					{/* Actions */}
					{isPerformance ? (
						<div className="space-y-4">
							{ending ? (
								<Button onClick={() => runAction(manageBilling)} disabled={pending}>
									{pending ? <Spinner /> : <CreditCard />} Open billing
								</Button>
							) : (
								<div className="space-y-4">
									{perfOffers.length > 1 ? (
										<div className="space-y-2">
											<p className="text-sm font-medium">Change billing term</p>
											<div className="flex flex-wrap items-center gap-2">
												<TermSwitcher offers={perfOffers} value={term} onChange={setTerm} />
												<Button
													size="sm"
													variant="outline"
													onClick={() => runAction(changeTerm)}
													disabled={pending || term === sub?.billing_term_months}
												>
													{pending ? <Spinner /> : null} Apply
												</Button>
											</div>
										</div>
									) : null}
									<ConfirmAction
										title="Switch to Free now?"
										description={
											<>
												This takes effect immediately. You’ll lose dual engines and higher burst,
												and the monthly AI Credits grant stops — your agent keeps running on Free.
												You can upgrade to Performance again later.
											</>
										}
										confirmLabel="Switch to Free"
										cancelLabel="Keep Performance"
										onConfirm={() => runAction(downgradeToFree)}
									>
										<Button variant="ghost" className="text-muted-foreground" disabled={pending}>
											Switch to Free
										</Button>
									</ConfirmAction>
								</div>
							)}
						</div>
					) : (
						<div className="space-y-3">
							{perfOffers.length > 1 ? (
								<TermSwitcher offers={perfOffers} value={term} onChange={setTerm} />
							) : null}
							<Button onClick={() => runAction(upgrade)} disabled={pending || !perfPlan}>
								{pending ? <Spinner /> : <Zap />} Upgrade to Performance
							</Button>
						</div>
					)}
				</CardContent>
			</Card>

			{/* Compare plans — the former Pricing tab, folded into the upgrade flow. */}
			<PlanComparison term={term} onTermChange={setTerm} />
		</div>
	);
}
