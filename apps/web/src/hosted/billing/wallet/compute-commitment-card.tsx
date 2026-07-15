"use client";

import { CalendarClock, Server, ShieldAlert } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import type { HostedDeployment, WalletState } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatCents, formatCentsCompact } from "@/hosted/billing/format";
import { walletComputeCoverage } from "@/hosted/billing/wallet/wallet-compute.logic";
import { agentSectionHref } from "@/lib/agent-routes";
import { formatShortDate } from "@/lib/format";

function coverageLabel(months: number | null): string {
	if (months === null) return "No wallet compute commitment";
	if (months >= 10) return "10+ months covered";
	return `${months.toLocaleString(undefined, { maximumFractionDigits: 1 })} months covered`;
}

export function ComputeCommitmentCard({
	wallet,
	deployments,
	isLoading,
	error,
	onRetry,
}: {
	wallet: WalletState;
	deployments: readonly HostedDeployment[] | undefined;
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
}) {
	const coverage = walletComputeCoverage(wallet, deployments);

	return (
		<Card data-hosted="true">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div>
					<CardTitle>Compute coverage</CardTitle>
					<CardDescription>
						Upcoming renewals funded from the same balance as managed AI.
					</CardDescription>
				</div>
				{isLoading ? (
					<Skeleton className="h-6 w-28" />
				) : coverage.lowCoverage ? (
					<StatusBadge status="warning">Under 1 month</StatusBadge>
				) : (
					<StatusBadge status="success">{coverageLabel(coverage.coverageMonths)}</StatusBadge>
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-5">
				{error && !deployments ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={error}
						onRetry={onRetry}
						title="Couldn’t load compute commitments"
					/>
				) : isLoading ? (
					<div className="flex flex-col gap-3">
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-16 w-full" />
					</div>
				) : coverage.deployments.length === 0 ? (
					<EmptyState
						variant="inset"
						icon={Server}
						title="No wallet-funded compute"
						description="Choose Wallet balance when deploying paid compute to see renewals here."
					/>
				) : (
					<>
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="rounded-lg border p-3">
								<div className="text-xs text-muted-foreground">Monthly commitment</div>
								<div className="mt-1 text-xl font-semibold tabular-nums">
									{formatCents(coverage.totalMonthlyCents)}
								</div>
							</div>
							<div className="rounded-lg border p-3">
								<div className="text-xs text-muted-foreground">Balance coverage</div>
								<div className="mt-1 text-xl font-semibold tabular-nums">
									{coverageLabel(coverage.coverageMonths)}
								</div>
							</div>
						</div>

						{coverage.lowCoverage ? (
							<div className="flex items-start gap-2 text-sm text-warning-muted-foreground">
								<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									Auto-reload is off and the current balance does not cover one month of compute.
									Renewals can enter a 72-hour grace period if the wallet stays short.
								</span>
							</div>
						) : null}

						<ul className="divide-y overflow-hidden rounded-lg border">
							{coverage.deployments.map((deployment) => (
								<li
									key={deployment.deploymentId}
									className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
								>
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<span className="truncate font-medium">
												{deploymentDisplayName(deployment.name)}
											</span>
											<Badge variant="outline">{deployment.planLabel}</Badge>
										</div>
										<div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
											<CalendarClock className="size-3.5" aria-hidden />
											{deployment.renews
												? deployment.nextRenewalAt
													? `${formatCentsCompact(deployment.priceCents)} on ${formatShortDate(deployment.nextRenewalAt)}`
													: `${formatCentsCompact(deployment.priceCents)} monthly · renewal pending`
												: `Ends ${formatShortDate(deployment.nextRenewalAt)} · no renewal charge`}
										</div>
									</div>
									<Button
										render={<a href={agentSectionHref(deployment.deploymentId, "settings")} />}
										nativeButton={false}
										variant="outline"
										size="sm"
									>
										Manage
									</Button>
								</li>
							))}
						</ul>
					</>
				)}
			</CardContent>
		</Card>
	);
}
