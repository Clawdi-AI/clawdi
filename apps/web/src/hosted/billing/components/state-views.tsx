"use client";

import { Coins } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsSection } from "@/components/settings-section";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder rendered through the real `SettingsSection` so heading, gaps,
 * and separator match the loaded section. Static copy stays real text. */
function SectionSkeleton({
	title,
	description,
	actions,
	children,
}: {
	title?: ReactNode;
	description?: ReactNode | false;
	actions?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<SettingsSection
			aria-hidden="true"
			headingLevel={3}
			title={title ?? <Skeleton className="h-lh w-28" />}
			description={
				description === false
					? undefined
					: (description ?? <Skeleton className="h-lh w-52 max-w-full" />)
			}
			actions={actions}
		>
			{children}
		</SettingsSection>
	);
}

/** Wallet: balance card followed by the same sections as loaded content. */
export function WalletSkeleton() {
	return (
		<div data-hosted="true" className="space-y-8">
			<Card aria-hidden="true">
				<CardContent className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
					<div className="space-y-1.5">
						<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
							<Coins className="size-4" aria-hidden />
							Wallet balance
						</div>
						<div className="text-4xl">
							<Skeleton className="h-lh w-40" />
						</div>
						<div className="text-xs">
							<Skeleton className="h-lh w-96 max-w-full" />
						</div>
					</div>
					<Skeleton className="h-9 w-full sm:w-28 lg:shrink-0" />
				</CardContent>
			</Card>
			<SectionSkeleton
				title="Payment methods"
				description="Cards saved to your billing account."
				actions={<Skeleton className="h-8 w-16" />}
			>
				<div className="space-y-3">
					<Skeleton className="h-16 w-full" />
					<div className="text-xs">
						<Skeleton className="h-lh w-72 max-w-full" />
					</div>
				</div>
			</SectionSkeleton>
			<SectionSkeleton
				title="Auto-reload"
				actions={<Skeleton className="h-5 w-9 shrink-0 rounded-full" />}
			/>
			<SectionSkeleton />
			<SectionSkeleton
				title="Transactions"
				description="Top-ups, compute payments, credits, and adjustments."
			>
				<TransactionRowsSkeleton />
			</SectionSkeleton>
		</div>
	);
}

/** Shared with TransactionsSection's own loading state. */
export function TransactionRowsSkeleton() {
	return (
		<div className="space-y-px overflow-hidden rounded-lg border">
			{Array.from({ length: 5 }, (_, index) => `transaction-${index}`).map((key) => (
				<div key={key} className="flex items-center justify-between gap-4 px-3 py-3">
					<Skeleton className="h-4 w-40" />
					<Skeleton className="h-4 w-16" />
				</div>
			))}
		</div>
	);
}

/** Usage: scoped totals, spend trend, and model table. */
export function UsageSkeleton() {
	return (
		<div data-hosted="true" className="space-y-8" aria-hidden="true">
			<div className="grid overflow-hidden rounded-lg border sm:grid-cols-2 sm:divide-x">
				{["Spend", "Requests"].map((label, index) => (
					<div
						key={label}
						className={
							index === 0 ? "space-y-1 p-4 sm:p-5" : "space-y-1 border-t p-4 sm:border-t-0 sm:p-5"
						}
					>
						<div className="text-xs font-medium text-muted-foreground">{label}</div>
						<div className="text-3xl">
							<Skeleton className="h-lh w-28" />
						</div>
					</div>
				))}
			</div>
			<SectionSkeleton title="Spend over time" description={false}>
				<div className="mb-3 flex justify-end text-xs">
					<Skeleton className="h-lh w-24" />
				</div>
				<Skeleton className="h-36 w-full sm:h-44" />
				<div className="mt-2 flex justify-between text-xs">
					<Skeleton className="h-lh w-12" />
					<Skeleton className="h-lh w-12" />
				</div>
			</SectionSkeleton>
			<SectionSkeleton title="Models" description={false}>
				<div className="border-b pb-2 text-xs">
					<Skeleton className="h-lh w-16" />
				</div>
				<div className="divide-y">
					{Array.from({ length: 3 }).map((_, index) => (
						<div key={index} className="flex items-start gap-2 py-3">
							<Skeleton className="size-8 shrink-0 rounded-md" />
							<div className="min-w-0 flex-1">
								<div className="text-sm">
									<Skeleton className="h-lh w-40 max-w-full" />
								</div>
								<div className="text-xs">
									<Skeleton className="h-lh w-24" />
								</div>
							</div>
							<div className="text-sm">
								<Skeleton className="h-lh w-16" />
							</div>
						</div>
					))}
				</div>
			</SectionSkeleton>
		</div>
	);
}
