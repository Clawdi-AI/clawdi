"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

type WikiLogOut = {
	id: string;
	page_id: string | null;
	page_slug: string | null;
	action: string;
	source_type: string | null;
	source_ref: string | null;
	metadata: Record<string, unknown> | null;
	ts: string;
};

type LogList = {
	items: WikiLogOut[];
	total: number;
	page: number;
	page_size: number;
};

const ACTION_COLORS: Record<string, string> = {
	extracted_from_memory: "text-blue-600 dark:text-blue-400",
	extracted_from_skill: "text-purple-600 dark:text-purple-400",
	extracted_from_session: "text-green-600 dark:text-green-400",
	extracted_from_vault: "text-amber-600 dark:text-amber-400",
	synthesized: "text-pink-600 dark:text-pink-400",
};

export default function WikiLogPage() {
	const { getToken } = useAuth();
	const { data, isLoading } = useQuery<LogList>({
		queryKey: ["wiki", "log"],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			return apiFetch<LogList>("/api/wiki/log?page_size=100", token);
		},
		// Activity feed is the kind of view people leave open; refresh every 30s.
		refetchInterval: 30_000,
	});

	return (
		<div className="max-w-4xl mx-auto space-y-6">
			<Link
				href="/wiki"
				className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
			>
				<ArrowLeft className="size-4" />
				Back to wiki
			</Link>

			<header className="space-y-2">
				<div className="flex items-center gap-2">
					<Activity className="size-6 text-muted-foreground" />
					<h1 className="text-2xl font-semibold">Wiki activity</h1>
					{data && <span className="text-sm text-muted-foreground ml-2">{data.total} events</span>}
				</div>
				<p className="text-sm text-muted-foreground max-w-prose">
					Every extraction, synthesis, and structural change to the wiki, newest first.
				</p>
			</header>

			{isLoading ? (
				<div className="space-y-2">
					{[...Array(8)].map((_, i) => (
						<Skeleton key={i} className="h-12 rounded" />
					))}
				</div>
			) : !data?.items.length ? (
				<div className="text-center py-16 text-muted-foreground">
					<Activity className="size-10 mx-auto mb-3 opacity-30" />
					<p className="text-sm">No activity yet.</p>
				</div>
			) : (
				<ol className="space-y-1">
					{data.items.map((e) => (
						<li
							key={e.id}
							className="flex items-baseline gap-3 py-1.5 border-b border-border/40 last:border-0"
						>
							<span className="text-xs text-muted-foreground font-mono shrink-0 w-32">
								{relativeTime(e.ts)}
							</span>
							<span
								className={
									ACTION_COLORS[e.action] ??
									"text-muted-foreground" + " text-xs font-medium shrink-0"
								}
							>
								{e.action.replace(/_/g, " ")}
							</span>
							{e.page_slug && (
								<Link href={`/wiki/${e.page_slug}`} className="text-sm hover:underline truncate">
									{e.page_slug}
								</Link>
							)}
							{e.source_type && (
								<span className="text-xs text-muted-foreground font-mono truncate">
									← {e.source_type}:{e.source_ref?.slice(0, 16)}
								</span>
							)}
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
