"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { API_URL, apiFetch } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

type ReviewItem = {
	page_id: string;
	slug: string;
	title: string;
	reason: "vault_leak" | "low_confidence" | "stale" | "no_synthesis";
	detail: string | null;
	detected_at: string;
};

type ReviewQueue = {
	items: ReviewItem[];
	total: number;
};

const REASON_META: Record<string, { label: string; icon: typeof AlertTriangle; color: string }> = {
	vault_leak: {
		label: "vault leak",
		icon: ShieldAlert,
		color: "text-red-600 dark:text-red-400 bg-red-500/10",
	},
	stale: {
		label: "stale",
		icon: AlertTriangle,
		color: "text-orange-600 dark:text-orange-400 bg-orange-500/10",
	},
	low_confidence: {
		label: "low confidence",
		icon: AlertTriangle,
		color: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
	},
	no_synthesis: {
		label: "no synthesis",
		icon: AlertTriangle,
		color: "text-blue-600 dark:text-blue-400 bg-blue-500/10",
	},
};

export default function WikiReviewPage() {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();

	const { data, isLoading } = useQuery<ReviewQueue>({
		queryKey: ["wiki", "review"],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			return apiFetch<ReviewQueue>("/api/wiki/review?page_size=100", token);
		},
	});

	const resolve = useMutation<{ slug: string }, Error, string>({
		mutationFn: async (slug) => {
			const token = (await getToken()) ?? "";
			const res = await fetch(`${API_URL}/api/wiki/review/${encodeURIComponent(slug)}/resolve`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!res.ok) throw new Error(`Resolve failed: ${res.status}`);
			return (await res.json()) as { slug: string };
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["wiki", "review"] });
		},
	});

	return (
		<div className="space-y-6">
			<header className="space-y-2">
				<div className="flex items-center gap-2">
					<ShieldAlert className="size-6 text-muted-foreground" />
					<h1 className="text-2xl font-semibold">Review queue</h1>
					{data && <span className="text-sm text-muted-foreground ml-2">{data.total} flagged</span>}
				</div>
				<p className="text-sm text-muted-foreground max-w-prose">
					Pages flagged for human review — vault leaks, stale entries, low-confidence extractions.
					Resolving clears the flag and logs an event.
				</p>
			</header>

			{isLoading ? (
				<div className="space-y-2">
					{[...Array(5)].map((_, i) => (
						<Skeleton key={i} className="h-16 rounded-lg" />
					))}
				</div>
			) : !data?.items.length ? (
				<div className="rounded-xl border border-dashed bg-card/50 p-10 text-center">
					<Check className="size-10 mx-auto mb-4 text-green-600 dark:text-green-400 opacity-80" />
					<h3 className="font-medium">All clear.</h3>
					<p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
						No pages currently flagged for review.
					</p>
				</div>
			) : (
				<ul className="space-y-2">
					{data.items.map((item) => {
						const meta = REASON_META[item.reason] ?? REASON_META.stale;
						const Icon = meta.icon;
						return (
							<li key={`${item.page_id}-${item.reason}`} className="rounded-lg border bg-card p-4">
								<div className="flex items-start gap-3">
									<span
										className={cn(
											"text-[10px] px-2 py-1 rounded font-medium uppercase tracking-wide inline-flex items-center gap-1",
											meta.color,
										)}
									>
										<Icon className="size-3" />
										{meta.label}
									</span>
									<div className="flex-1 min-w-0">
										<Link href={`/wiki/${item.slug}`} className="font-medium hover:underline">
											{item.title}
										</Link>
										<div className="text-xs text-muted-foreground font-mono mt-0.5">
											{item.slug}
										</div>
										{item.detail && (
											<div className="text-xs text-muted-foreground mt-1.5">{item.detail}</div>
										)}
									</div>
									<div className="text-xs text-muted-foreground shrink-0">
										{relativeTime(item.detected_at)}
									</div>
									<button
										type="button"
										onClick={() => resolve.mutate(item.slug)}
										disabled={resolve.isPending}
										className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border bg-background hover:bg-accent/50 transition-colors disabled:opacity-50 shrink-0"
									>
										{resolve.isPending ? (
											<Loader2 className="size-3 animate-spin" />
										) : (
											<Check className="size-3" />
										)}
										Resolve
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
