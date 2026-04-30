"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import {
	BarChart3,
	BookOpen,
	FileText,
	GitMerge,
	HelpCircle,
	Layout as LayoutIcon,
	Lightbulb,
	Loader2,
	type LucideIcon,
	Search,
	Users,
} from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

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
	page: number;
	page_size: number;
};

const KIND_FILTERS = [
	{ value: "", label: "All" },
	{ value: "entity", label: "Entities" },
	{ value: "concept", label: "Concepts" },
	{ value: "synthesis", label: "Syntheses" },
	{ value: "source", label: "Sources" },
] as const;

const KIND_META: Record<
	string,
	{ icon: LucideIcon; color: string; cardClass: string; order: number }
> = {
	overview: {
		icon: LayoutIcon,
		color: "text-yellow-500",
		cardClass: "border-yellow-500/20 bg-yellow-500/5",
		order: 0,
	},
	entity: {
		icon: Users,
		color: "text-blue-500",
		cardClass: "border-blue-500/20 bg-blue-500/[0.03]",
		order: 1,
	},
	concept: {
		icon: Lightbulb,
		color: "text-purple-500",
		cardClass: "border-purple-500/20 bg-purple-500/[0.03]",
		order: 2,
	},
	source: {
		icon: BookOpen,
		color: "text-orange-500",
		cardClass: "border-orange-500/20 bg-orange-500/[0.03]",
		order: 3,
	},
	synthesis: {
		icon: GitMerge,
		color: "text-red-500",
		cardClass: "border-red-500/20 bg-red-500/[0.03]",
		order: 4,
	},
	comparison: {
		icon: BarChart3,
		color: "text-emerald-500",
		cardClass: "border-emerald-500/20 bg-emerald-500/[0.03]",
		order: 5,
	},
	query: {
		icon: HelpCircle,
		color: "text-green-500",
		cardClass: "border-green-500/20 bg-green-500/[0.03]",
		order: 6,
	},
};

function kindMeta(kind: string) {
	return (
		KIND_META[kind] ?? {
			icon: FileText,
			color: "text-muted-foreground",
			cardClass: "",
			order: 99,
		}
	);
}

export default function WikiIndexPage() {
	const { getToken } = useAuth();
	const [searchQuery, setSearchQuery] = useState("");
	const [kind, setKind] = useState<string>("");
	const deferredQuery = useDeferredValue(searchQuery);

	const { data, isLoading, isFetching } = useQuery<PageList>({
		queryKey: ["wiki", "pages", { kind, q: deferredQuery }],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			const params = new URLSearchParams({ page_size: "200" });
			if (kind) params.set("kind", kind);
			if (deferredQuery.trim()) params.set("q", deferredQuery.trim());
			return apiFetch<PageList>(`/api/wiki/pages?${params.toString()}`, token);
		},
	});

	const items = data?.items ?? [];

	// Sort by source_count desc inside each kind, group sections by KIND_META.order.
	const grouped: Record<string, WikiPageSummary[]> = {};
	for (const p of items) {
		const k = p.kind || "entity";
		const bucket = grouped[k] ?? [];
		bucket.push(p);
		grouped[k] = bucket;
	}
	const groups = Object.entries(grouped)
		.map(([k, ps]) => ({ kind: k, pages: [...ps].sort((a, b) => b.source_count - a.source_count) }))
		.sort((a, b) => kindMeta(a.kind).order - kindMeta(b.kind).order);

	return (
		<div className="space-y-6">
			<header className="flex items-end justify-between gap-4 flex-wrap">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<BookOpen className="size-5 text-muted-foreground" />
						<h1 className="text-xl font-semibold">Pages</h1>
						{data && (
							<span className="text-xs text-muted-foreground">
								{data.total} {data.total === 1 ? "page" : "pages"}
							</span>
						)}
					</div>
					<p className="text-xs text-muted-foreground max-w-prose">
						Synthesized knowledge across your sessions, memories, skills, and vault.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
						<input
							type="search"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search title, slug, or content…"
							className="w-72 pl-9 pr-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>
					<div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
						{KIND_FILTERS.map((f) => (
							<button
								key={f.value}
								type="button"
								onClick={() => setKind(f.value)}
								className={cn(
									"px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
									kind === f.value
										? "bg-background text-foreground shadow-sm"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{f.label}
							</button>
						))}
					</div>
					{isFetching && !isLoading && (
						<Loader2 className="size-4 text-muted-foreground animate-spin" />
					)}
				</div>
			</header>

			{isLoading ? (
				<div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
					{[...Array(6)].map((_, i) => (
						<Skeleton key={i} className="h-28 rounded-lg" />
					))}
				</div>
			) : items.length === 0 ? (
				<EmptyState query={deferredQuery} hasAny={(data?.total ?? 0) > 0} />
			) : (
				<div className="space-y-8">
					{groups.map(({ kind: k, pages }) => {
						const meta = kindMeta(k);
						const Icon = meta.icon;
						return (
							<section key={k} className="space-y-3">
								<div className="flex items-center gap-2">
									<Icon className={cn("size-4", meta.color)} />
									<h2 className="text-sm font-semibold capitalize">
										{k}
										<span className="ml-2 text-xs font-normal text-muted-foreground font-mono">
											{pages.length}
										</span>
									</h2>
								</div>
								<ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
									{pages.map((p) => (
										<li key={p.id}>
											<PageCard page={p} />
										</li>
									))}
								</ul>
							</section>
						);
					})}
				</div>
			)}
		</div>
	);
}

function PageCard({ page }: { page: WikiPageSummary }) {
	const meta = kindMeta(page.kind);
	const Icon = meta.icon;
	return (
		<Link
			href={`/wiki/${page.slug}`}
			className={cn(
				"block rounded-lg border bg-card p-3 hover:bg-accent/30 transition-colors h-full",
				meta.cardClass,
			)}
		>
			<div className="flex items-start gap-2.5">
				<div
					className={cn(
						"size-8 rounded-md bg-background/60 flex items-center justify-center shrink-0",
						meta.color,
					)}
				>
					<Icon className="size-4" />
				</div>
				<div className="flex-1 min-w-0">
					<div className="font-medium text-sm leading-snug line-clamp-2 break-words">
						{page.title}
					</div>
					<div className="mt-1 text-[10px] text-muted-foreground font-mono truncate">
						{page.slug}
					</div>
					<div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
						<span>
							{page.source_count} src{page.source_count === 1 ? "" : "s"}
						</span>
						<span>·</span>
						<span>{relativeTime(page.updated_at)}</span>
						{page.stale && (
							<span className="ml-auto text-orange-600 dark:text-orange-400 font-medium">
								stale
							</span>
						)}
					</div>
				</div>
			</div>
		</Link>
	);
}

function EmptyState({ query, hasAny }: { query: string; hasAny: boolean }) {
	if (query) {
		return (
			<div className="text-center py-16 text-muted-foreground">
				<FileText className="size-10 mx-auto mb-3 opacity-30" />
				<p className="text-sm">No pages matching &ldquo;{query}&rdquo;.</p>
			</div>
		);
	}
	if (hasAny) {
		return (
			<div className="text-center py-16 text-muted-foreground">
				<FileText className="size-10 mx-auto mb-3 opacity-30" />
				<p className="text-sm">No pages match the current filter.</p>
			</div>
		);
	}
	return (
		<div className="rounded-xl border border-dashed bg-card/50 p-10 text-center">
			<BookOpen className="size-10 mx-auto mb-4 text-muted-foreground opacity-50" />
			<h3 className="font-medium">Your wiki is empty.</h3>
			<p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
				As your synced sessions and memories grow, Clawdi will auto-generate wiki pages — one per
				real-world entity, project, or concept.
			</p>
		</div>
	);
}
