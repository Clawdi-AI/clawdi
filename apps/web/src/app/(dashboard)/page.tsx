"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import {
	BarChart3,
	Brain,
	Key,
	type LucideIcon,
	MessageSquare,
	Plug,
	Sparkles,
	Zap,
} from "lucide-react";
import Link from "next/link";
import { ContributionGraph } from "@/components/dashboard/contribution-graph";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import type { ContributionDay, DashboardStats, SessionListItem } from "@/lib/api-schemas";
import { cn, formatNumber, formatSessionSummary, relativeTime } from "@/lib/utils";

export default function DashboardPage() {
	const { getToken } = useAuth();

	const { data: stats, isLoading: statsLoading } = useQuery({
		queryKey: ["dashboard-stats"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<DashboardStats>("/api/dashboard/stats", token);
		},
	});

	const { data: contribution, isLoading: contribLoading } = useQuery({
		queryKey: ["dashboard-contribution"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<ContributionDay[]>("/api/dashboard/contribution", token);
		},
	});

	const { data: sessions } = useQuery({
		queryKey: ["recent-sessions"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<SessionListItem[]>("/api/sessions?limit=5", token);
		},
	});

	const isNewUser = stats && stats.total_sessions === 0;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Overview"
				description="Your agents at a glance — activity, usage, and recent sessions."
			/>

			{/* Onboarding for new users */}
			{!statsLoading && isNewUser && <OnboardingCard />}

			{/* Module stats */}
			{statsLoading ? (
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
					{Array.from({ length: 6 }).map((_, i) => (
						<div key={i} className="rounded-lg border bg-card px-4 py-3 space-y-2">
							<Skeleton className="h-3 w-16" />
							<Skeleton className="h-6 w-10" />
						</div>
					))}
				</div>
			) : stats ? (
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
					<ModuleCard
						href="/sessions"
						icon={BarChart3}
						label="Sessions"
						value={formatNumber(stats.total_sessions)}
					/>
					<ModuleCard
						href="/sessions"
						icon={MessageSquare}
						label="Messages"
						value={formatNumber(stats.total_messages)}
					/>
					<ModuleCard
						href="/skills"
						icon={Sparkles}
						label="Skills"
						value={String(stats.skills_count ?? 0)}
					/>
					<ModuleCard
						href="/memories"
						icon={Brain}
						label="Memories"
						value={String(stats.memories_count ?? 0)}
					/>
					<ModuleCard
						href="/vault"
						icon={Key}
						label="Vault Keys"
						value={String(stats.vault_keys_count ?? 0)}
					/>
					<ModuleCard
						href="/connectors"
						icon={Plug}
						label="Connectors"
						value={String(stats.connectors_count ?? 0)}
					/>
				</div>
			) : null}

			{/* Session stats row */}
			{stats && (
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<StatCard label="Total tokens" value={formatNumber(stats.total_tokens)} />
					<StatCard label="Active days" value={String(stats.active_days)} />
					<StatCard label="Current streak" value={`${stats.current_streak}d`} />
					<StatCard
						label="Favorite model"
						value={stats.favorite_model?.replace("claude-", "") ?? "-"}
					/>
				</div>
			)}

			{/* Activity graph */}
			<div>
				<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
					Activity
				</h2>
				{contribLoading ? (
					<Skeleton className="h-28 w-full rounded-lg" />
				) : contribution ? (
					<ContributionGraph data={contribution} />
				) : null}
			</div>

			{/* Recent Sessions */}
			<div>
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Recent Sessions
					</h2>
					<Link
						href="/sessions"
						className="text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						View all
					</Link>
				</div>
				{sessions?.length ? (
					<div className="rounded-lg border">
						{sessions.map((s, i) => (
							<Link
								key={s.id}
								href={`/sessions/${s.id}`}
								className={cn(
									"flex items-center justify-between px-4 py-3 hover:bg-accent/40 transition-colors",
									i > 0 && "border-t",
								)}
							>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium truncate">
										{formatSessionSummary(s.summary) || s.local_session_id.slice(0, 8)}
									</div>
									<div className="flex items-center gap-2 mt-0.5">
										<span className="text-xs text-muted-foreground">
											{s.project_path?.split("/").pop() ?? "-"}
										</span>
										{s.model && (
											<span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
												{s.model.replace("claude-", "")}
											</span>
										)}
										<span className="text-xs text-muted-foreground">{s.message_count} msgs</span>
										<span className="text-xs text-muted-foreground">
											<Zap className="inline size-3" />{" "}
											{((s.input_tokens + s.output_tokens) / 1000).toFixed(1)}k
										</span>
									</div>
								</div>
								<span className="text-xs text-muted-foreground ml-4 shrink-0">
									{relativeTime(s.started_at)}
								</span>
							</Link>
						))}
					</div>
				) : (
					<EmptyState
						description={
							<>
								No sessions yet. Run{" "}
								<code className="bg-muted px-1.5 py-0.5 rounded text-xs">clawdi sync up</code> to
								sync.
							</>
						}
					/>
				)}
			</div>
		</div>
	);
}

function ModuleCard({
	href,
	icon: Icon,
	label,
	value,
}: {
	href: string;
	icon: LucideIcon;
	label: string;
	value: string;
}) {
	return (
		<Link
			href={href}
			className="rounded-lg border bg-card px-4 py-3 hover:border-foreground/15 hover:bg-accent/40 transition-all"
		>
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Icon className="size-3.5" />
				{label}
			</div>
			<div className="text-xl font-semibold mt-1">{value}</div>
		</Link>
	);
}

function StatCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border bg-card px-4 py-3">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="text-lg font-semibold mt-1">{value}</div>
		</div>
	);
}
