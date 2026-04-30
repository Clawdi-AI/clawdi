"use client";

/**
 * 3-column wiki layout — icon sidebar (left), knowledge tree (collapsible),
 * and the content area on the right.
 *
 * Mirrors nashsu/llm_wiki's AppLayout: chat-first, with persistent global
 * navigation icons on the far left and a contextual file/knowledge tree
 * adjacent to it.
 */

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import {
	Activity,
	BookOpen,
	ChevronRight,
	FileText,
	MessageSquare,
	Network,
	Search,
	Settings,
	ShieldAlert,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

type WikiPageSummary = {
	id: string;
	slug: string;
	title: string;
	kind: string;
	source_count: number;
	stale: boolean;
	last_synthesis_at: string | null;
	updated_at: string;
};

type PageList = {
	items: WikiPageSummary[];
	total: number;
};

type ReviewQueue = { items: unknown[]; total: number };

const NAV_ITEMS = [
	{ href: "/wiki", icon: MessageSquare, label: "Chat", match: (p: string) => p === "/wiki" },
	{
		href: "/wiki/pages",
		icon: BookOpen,
		label: "Pages",
		match: (p: string) => p.startsWith("/wiki/pages") || p.match(/^\/wiki\/[^/]+$/) !== null,
	},
	{
		href: "/wiki/research",
		icon: Sparkles,
		label: "Deep Research",
		match: (p: string) => p.startsWith("/wiki/research"),
	},
	{
		href: "/wiki/graph",
		icon: Network,
		label: "Graph",
		match: (p: string) => p.startsWith("/wiki/graph"),
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
	const [treeOpen, setTreeOpen] = useState(true);
	const [searchQuery, setSearchQuery] = useState("");

	const { data: pageList } = useQuery<PageList>({
		queryKey: ["wiki", "tree", searchQuery],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			const params = new URLSearchParams({ page_size: "200" });
			if (searchQuery.trim()) params.set("q", searchQuery.trim());
			return apiFetch<PageList>(`/api/wiki/pages?${params.toString()}`, token);
		},
		// Tree refreshes every 60s — picks up newly-created pages without a
		// hard reload.
		refetchInterval: 60_000,
	});

	const { data: reviewQueue } = useQuery<ReviewQueue>({
		queryKey: ["wiki", "review-badge"],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			return apiFetch<ReviewQueue>("/api/wiki/review?page_size=1", token);
		},
		refetchInterval: 30_000,
	});

	// Group pages by kind for the KnowledgeTree.
	const pagesByKind: Record<string, WikiPageSummary[]> = {};
	for (const p of pageList?.items ?? []) {
		const k = p.kind || "entity";
		const bucket = pagesByKind[k] ?? [];
		bucket.push(p);
		pagesByKind[k] = bucket;
	}

	return (
		<div className="flex h-[calc(100vh-3.5rem)] -mx-4 -my-6 sm:-mx-6 lg:-mx-8 border-t">
			{/* Icon sidebar (fixed width) */}
			<nav
				className="w-14 shrink-0 border-r bg-muted/30 flex flex-col items-center py-3 gap-1"
				aria-label="Wiki sections"
			>
				{NAV_ITEMS.map((item) => {
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
							title={item.label}
							className={cn(
								"size-10 rounded-lg flex items-center justify-center relative transition-colors",
								active
									? "bg-primary/10 text-primary"
									: "text-muted-foreground hover:bg-accent hover:text-foreground",
							)}
						>
							<Icon className="size-5" />
							{badge != null && (
								<span className="absolute -top-1 -right-1 size-4 rounded-full bg-destructive text-[10px] text-destructive-foreground flex items-center justify-center font-medium">
									{badge}
								</span>
							)}
						</Link>
					);
				})}
				<div className="flex-1" />
				<Link
					href="/settings"
					title="Settings"
					className="size-10 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
				>
					<Settings className="size-5" />
				</Link>
			</nav>

			{/* Knowledge tree (resizable conceptually; static-width for now) */}
			<aside
				className={cn(
					"shrink-0 border-r bg-muted/10 flex flex-col transition-all overflow-hidden",
					treeOpen ? "w-72" : "w-0",
				)}
			>
				<div className="p-3 border-b shrink-0 space-y-2">
					<div className="flex items-center justify-between">
						<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							Knowledge tree
						</h2>
						<span className="text-[10px] text-muted-foreground font-mono">
							{pageList?.total ?? 0}
						</span>
					</div>
					<div className="relative">
						<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
						<input
							type="search"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search pages…"
							className="w-full pl-8 pr-2 py-1.5 text-xs rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
						/>
					</div>
				</div>
				<div className="flex-1 overflow-y-auto p-2 space-y-3">
					{Object.entries(pagesByKind)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([kind, pages]) => (
							<TreeGroup key={kind} kind={kind} pages={pages} pathname={pathname} />
						))}
					{(pageList?.items.length ?? 0) === 0 && (
						<div className="text-xs text-muted-foreground text-center py-6">
							No pages match &ldquo;{searchQuery}&rdquo;.
						</div>
					)}
				</div>
			</aside>

			{/* Toggle button between tree and content */}
			<button
				type="button"
				onClick={() => setTreeOpen((v) => !v)}
				title={treeOpen ? "Collapse tree" : "Expand tree"}
				className="w-3 hover:bg-muted/50 transition-colors flex items-center justify-center group"
			>
				<ChevronRight
					className={cn(
						"size-3 text-muted-foreground transition-transform",
						treeOpen ? "rotate-180" : "rotate-0",
					)}
				/>
			</button>

			{/* Content area */}
			<main className="flex-1 overflow-y-auto">
				<div className="px-6 py-6 max-w-none">{children}</div>
			</main>
		</div>
	);
}

function TreeGroup({
	kind,
	pages,
	pathname,
}: {
	kind: string;
	pages: WikiPageSummary[];
	pathname: string;
}) {
	const [open, setOpen] = useState(true);
	const sorted = [...pages].sort((a, b) => b.source_count - a.source_count);
	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="w-full flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors px-1 py-0.5"
			>
				<ChevronRight
					className={cn("size-3 transition-transform", open ? "rotate-90" : "rotate-0")}
				/>
				<span>{kind}</span>
				<span className="ml-auto text-[10px] font-mono opacity-60">{pages.length}</span>
			</button>
			{open && (
				<ul className="mt-0.5 space-y-px">
					{sorted.map((p) => {
						const active = pathname === `/wiki/${p.slug}` || pathname === `/wiki/pages/${p.slug}`;
						return (
							<li key={p.id}>
								<Link
									href={`/wiki/${p.slug}`}
									className={cn(
										"flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors",
										active
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
									)}
								>
									<FileText className="size-3 shrink-0 opacity-60" />
									<span className="truncate flex-1">{p.title}</span>
									{p.source_count > 0 && (
										<span className="text-[10px] font-mono opacity-50 shrink-0">
											{p.source_count}
										</span>
									)}
								</Link>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
