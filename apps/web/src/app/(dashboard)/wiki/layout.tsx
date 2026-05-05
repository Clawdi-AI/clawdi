"use client";

/**
 * Top-tab wiki layout — graph is the default landing view; chat + deep
 * research are merged into one page; pages, review, activity sit alongside
 * as siblings. Full horizontal width is given to the content area so the
 * graph and entity pages can render at full size.
 */

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { Activity, BookOpen, Loader2, MessageSquare, Network, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

type ReviewQueue = { items: unknown[]; total: number };

type WikiStatus = {
	pages_total: number;
	pages_synthesized: number;
	pages_by_kind: Record<string, number>;
	sessions_total: number;
	sessions_extracted: number;
	memories_total: number;
	last_extraction_at: string | null;
	last_synthesis_at: string | null;
	is_active: boolean;
};

const TABS = [
	{
		href: "/wiki",
		icon: Network,
		label: "Graph",
		// Graph is the wiki's default; matches /wiki exactly OR /wiki/<slug>
		// (page detail still inherits the graph tab as "active" until Pages
		// becomes the right home for /wiki/[slug]).
		match: (p: string) => p === "/wiki" || /^\/wiki\/[^/]+$/.test(p),
	},
	{
		href: "/wiki/chat",
		icon: MessageSquare,
		label: "Chat",
		match: (p: string) => p.startsWith("/wiki/chat"),
	},
	{
		href: "/wiki/pages",
		icon: BookOpen,
		label: "Pages",
		match: (p: string) => p.startsWith("/wiki/pages"),
	},
	{
		href: "/wiki/review",
		icon: ShieldAlert,
		label: "Review",
		match: (p: string) => p.startsWith("/wiki/review"),
		showBadge: "review" as const,
	},
	{
		href: "/wiki/log",
		icon: Activity,
		label: "Activity",
		match: (p: string) => p.startsWith("/wiki/log"),
	},
];

export default function WikiLayout({ children }: { children: ReactNode }) {
	const pathname = usePathname() ?? "/wiki";
	const { getToken } = useAuth();

	const { data: reviewQueue } = useQuery<ReviewQueue>({
		queryKey: ["wiki", "review-badge"],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			return apiFetch<ReviewQueue>("/api/wiki/review?page_size=1", token);
		},
		refetchInterval: 30_000,
	});

	// Status badge — polled every 5s while the user is on a wiki tab. Drives
	// the "syncing" indicator in the tab bar so users see when a session
	// upload or memory write is being absorbed into the wiki.
	const { data: status } = useQuery<WikiStatus>({
		queryKey: ["wiki", "status"],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			return apiFetch<WikiStatus>("/api/wiki/status", token);
		},
		refetchInterval: 5_000,
	});

	return (
		<div className="flex flex-col h-[calc(100svh-7rem)] -mt-4 md:-mt-6 rounded-xl border overflow-hidden bg-card">
			{/* Top tab bar — replaces the old icon column. Sits inside the dashboard frame. */}
			<nav
				className="flex items-center gap-0.5 px-3 py-2 border-b bg-muted/30 shrink-0"
				aria-label="Wiki sections"
			>
				{TABS.map((item) => {
					const Icon = item.icon;
					const active = item.match(pathname);
					const badge =
						item.showBadge === "review" && (reviewQueue?.total ?? 0) > 0
							? reviewQueue?.total
							: null;
					return (
						<Link
							key={item.href}
							href={item.href}
							className={cn(
								"flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors relative",
								active
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:bg-accent hover:text-foreground",
							)}
						>
							<Icon className="size-4" />
							<span>{item.label}</span>
							{badge != null && (
								<span className="ml-1 inline-flex items-center justify-center size-4 rounded-full bg-destructive text-[10px] text-destructive-foreground font-medium leading-none">
									{badge}
								</span>
							)}
						</Link>
					);
				})}
				<div className="ml-auto">
					<WikiStatusBadge status={status} />
				</div>
			</nav>

			{/* Content area — full horizontal width for graph / pages / source raw files */}
			<main className="flex-1 overflow-y-auto">
				<div className="px-6 py-6 max-w-none">{children}</div>
			</main>
		</div>
	);
}

function WikiStatusBadge({ status }: { status?: WikiStatus }) {
	if (!status) return null;

	if (status.is_active) {
		return (
			<span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<Loader2 className="size-3.5 animate-spin text-primary" />
				<span>
					Syncing wiki · {status.pages_synthesized}/{status.pages_total}
				</span>
			</span>
		);
	}

	const pct =
		status.pages_total > 0
			? Math.round((status.pages_synthesized / status.pages_total) * 100)
			: 100;
	return (
		<span
			className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
			title={`${status.sessions_extracted}/${status.sessions_total} sessions extracted · ${status.memories_total} memories`}
		>
			<span className="inline-block size-1.5 rounded-full bg-emerald-500" />
			<span>
				{status.pages_total} page{status.pages_total === 1 ? "" : "s"} · {pct}% synced
			</span>
		</span>
	);
}
