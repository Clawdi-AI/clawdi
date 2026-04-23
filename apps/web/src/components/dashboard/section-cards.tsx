"use client";

import { BarChart3, Flame, MessageSquare, TrendingUp, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardAction,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardStats } from "@/lib/api-schemas";
import { formatNumber } from "@/lib/utils";

/**
 * Four headline stat cards at the top of the dashboard — mirrors the shadcn
 * `dashboard-01` block's SectionCards. Each card is a `@container/card` so
 * the big number scales with its own width rather than the viewport.
 */
export function SectionCards({ stats }: { stats: DashboardStats | undefined }) {
	if (!stats) {
		return <SectionCardsSkeleton />;
	}

	const totalTokens = stats.total_tokens;
	const streak = stats.current_streak;

	return (
		<div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
			<StatCard
				description="Sessions"
				value={formatNumber(stats.total_sessions)}
				badge={
					<Badge variant="outline">
						<BarChart3 />
						Synced
					</Badge>
				}
				footerTitle={`${stats.active_days} active days`}
				footerDescription="across the last 12 months"
			/>
			<StatCard
				description="Messages"
				value={formatNumber(stats.total_messages)}
				badge={
					<Badge variant="outline">
						<MessageSquare />
						Total
					</Badge>
				}
				footerTitle={`~${formatNumber(Math.round(stats.total_messages / Math.max(1, stats.total_sessions)))} per session`}
				footerDescription="average conversation length"
			/>
			<StatCard
				description="Tokens"
				value={formatNumber(totalTokens)}
				badge={
					<Badge variant="outline">
						<Zap />
						Input + output
					</Badge>
				}
				footerTitle={stats.favorite_model?.replace("claude-", "") ?? "No model yet"}
				footerDescription="most-used model"
			/>
			<StatCard
				description="Streak"
				value={`${streak}d`}
				badge={
					<Badge variant="outline">
						<Flame />
						{stats.longest_streak}d best
					</Badge>
				}
				footerTitle={
					streak > 0 ? (
						<span className="flex items-center gap-1">
							Still going <TrendingUp className="size-4" />
						</span>
					) : (
						"Start a session today"
					)
				}
				footerDescription={streak > 0 ? "current active streak" : "to begin your streak"}
			/>
		</div>
	);
}

function StatCard({
	description,
	value,
	badge,
	footerTitle,
	footerDescription,
}: {
	description: string;
	value: string;
	badge: ReactNode;
	footerTitle: ReactNode;
	footerDescription: ReactNode;
}) {
	return (
		<Card className="@container/card">
			<CardHeader>
				<CardDescription>{description}</CardDescription>
				<CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
					{value}
				</CardTitle>
				<CardAction>{badge}</CardAction>
			</CardHeader>
			<CardFooter className="flex-col items-start gap-1.5 text-sm">
				<div className="line-clamp-1 flex gap-2 font-medium">{footerTitle}</div>
				<div className="text-muted-foreground">{footerDescription}</div>
			</CardFooter>
		</Card>
	);
}

function SectionCardsSkeleton() {
	return (
		<div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
			{Array.from({ length: 4 }).map((_, i) => (
				<Card key={i} className="@container/card">
					<CardHeader>
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-8 w-28" />
					</CardHeader>
					<CardFooter className="flex-col items-start gap-1.5">
						<Skeleton className="h-4 w-40" />
						<Skeleton className="h-3 w-32" />
					</CardFooter>
				</Card>
			))}
		</div>
	);
}
