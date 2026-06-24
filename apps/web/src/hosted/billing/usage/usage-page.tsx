"use client";

import { Activity } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BillingEmpty, BillingError } from "@/hosted/billing/components/state-views";
import { UsageMeter } from "@/hosted/billing/components/usage-meter";
import { formatCredits } from "@/hosted/billing/format";
import { useSubscription, useUsage } from "@/hosted/billing/hooks";
import { shortDate } from "@/hosted/billing/subscription/subscription-utils";

const DESCRIPTION = "AI Credit consumption across your agents this period.";

export function UsagePage() {
	const usage = useUsage();
	const subscription = useSubscription();

	if (usage.isLoading) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Usage" description={DESCRIPTION} />
				<Skeleton className="h-28 w-full rounded-lg" />
				<Skeleton className="h-48 w-full rounded-lg" />
			</div>
		);
	}

	if (usage.error || !usage.data) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Usage" description={DESCRIPTION} />
				<BillingError error={usage.error} onRetry={() => usage.refetch()} />
			</div>
		);
	}

	const u = usage.data;
	const sub = subscription.data ?? null;
	const showAllowance = !!sub && sub.budget_credits_total > 0;
	const maxDay = Math.max(1, ...u.by_day.map((d) => d.credits));
	const maxModel = Math.max(1, ...u.by_model.map((m) => m.credits));

	if (u.total_credits === 0 && u.by_model.length === 0) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Usage" description={DESCRIPTION} />
				<BillingEmpty
					icon={<Activity />}
					title="No usage yet"
					description="Once your agents start running, credit consumption shows up here."
				/>
			</div>
		);
	}

	return (
		<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
			<PageHeader
				title="Usage"
				description={`${shortDate(u.period_start)} – ${shortDate(u.period_end)}`}
			/>

			{subscription.error ? (
				<BillingError
					error={subscription.error}
					onRetry={() => subscription.refetch()}
					title="Couldn’t load Performance allowance"
				/>
			) : null}

			{/* Totals */}
			<div className="grid gap-3 sm:grid-cols-2">
				<Card data-hosted="true">
					<CardContent>
						<div className="text-3xl font-semibold tabular-nums">
							{formatCredits(u.total_credits)}
						</div>
						<div className="text-sm text-muted-foreground">AI Credits used</div>
					</CardContent>
				</Card>
				<Card data-hosted="true">
					<CardContent>
						<div className="text-3xl font-semibold tabular-nums">
							{u.total_requests.toLocaleString()}
						</div>
						<div className="text-sm text-muted-foreground">Requests</div>
					</CardContent>
				</Card>
			</div>

			{/* Monthly allowance meter (Performance plans) */}
			{showAllowance && sub ? (
				<Card data-hosted="true">
					<CardHeader>
						<CardTitle className="text-base">Monthly AI Credits</CardTitle>
					</CardHeader>
					<CardContent className="space-y-1.5">
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Performance allowance</span>
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
					</CardContent>
				</Card>
			) : null}

			{/* Daily consumption */}
			<Card data-hosted="true">
				<CardHeader>
					<CardTitle className="text-base">Daily consumption</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex h-28 items-end gap-1">
						{u.by_day.map((d) => (
							<div
								key={d.date}
								title={`${d.date}: ${formatCredits(d.credits)} credits`}
								className="flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
								style={{ height: `${Math.max(2, (d.credits / maxDay) * 100)}%` }}
							/>
						))}
					</div>
					<div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
						<span>{u.by_day[0]?.date.slice(5)}</span>
						<span>{u.by_day[u.by_day.length - 1]?.date.slice(5)}</span>
					</div>
				</CardContent>
			</Card>

			{/* By model */}
			<Card data-hosted="true">
				<CardHeader>
					<CardTitle className="text-base">By model</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					{u.by_model.map((m) => (
						<div key={`${m.provider ?? "managed"}:${m.model}`} className="space-y-1">
							<div className="flex items-baseline justify-between gap-2 text-sm">
								<span className="truncate font-medium">{m.model}</span>
								<span className="shrink-0 tabular-nums">{formatCredits(m.credits)}</span>
							</div>
							<div className="h-2 overflow-hidden rounded-full bg-muted">
								<div
									className="h-2 rounded-full bg-primary"
									style={{ width: `${(m.credits / maxModel) * 100}%` }}
								/>
							</div>
							<div className="text-xs text-muted-foreground">
								{m.provider ? `${m.provider} · ` : ""}
								{m.requests.toLocaleString()} requests
							</div>
						</div>
					))}
				</CardContent>
			</Card>
		</div>
	);
}
