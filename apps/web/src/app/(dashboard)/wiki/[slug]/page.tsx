"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import {
	AlertTriangle,
	ArrowLeft,
	Brain,
	Clock,
	FileText,
	Key,
	Link2,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

type WikiLinkOut = {
	id: string;
	link_type: string;
	confidence: number | null;
	to_page_id: string | null;
	to_page_slug: string | null;
	to_page_title: string | null;
	source_type: string | null;
	source_ref: string | null;
	source_page_slug: string | null;
	source_page_title: string | null;
};

type WikiPageDetail = {
	id: string;
	slug: string;
	title: string;
	kind: string;
	compiled_truth: string | null;
	frontmatter: Record<string, unknown> | null;
	source_count: number;
	stale: boolean;
	last_synthesis_at: string | null;
	created_at: string;
	updated_at: string;
	outgoing_links: WikiLinkOut[];
	backlinks: WikiLinkOut[];
};

const SOURCE_ICONS: Record<string, typeof Brain> = {
	memory: Brain,
	skill: Sparkles,
	session: FileText,
	vault: Key,
};

const SOURCE_COLORS: Record<string, string> = {
	memory: "text-blue-600 dark:text-blue-400",
	skill: "text-purple-600 dark:text-purple-400",
	session: "text-green-600 dark:text-green-400",
	vault: "text-amber-600 dark:text-amber-400",
};

export default function WikiPageView() {
	const { getToken } = useAuth();
	const params = useParams<{ slug: string }>();
	const slug = params?.slug;

	const { data, isLoading, error } = useQuery<WikiPageDetail>({
		queryKey: ["wiki", "page", slug],
		queryFn: async () => {
			if (!slug) throw new Error("missing slug");
			const token = (await getToken()) ?? "";
			return apiFetch<WikiPageDetail>(`/api/wiki/pages/${encodeURIComponent(slug)}`, token);
		},
		enabled: !!slug,
		retry: (count, err: Error) => !err.message.includes("404") && count < 2,
	});

	if (error?.message.includes("404")) notFound();

	return (
		<div className="space-y-4">
			<div>
				<Link
					href="/wiki"
					className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
				>
					<ArrowLeft className="size-3.5" />
					Back to graph
				</Link>
			</div>
			{isLoading ? (
				<div className="space-y-4">
					<Skeleton className="h-8 w-1/2" />
					<Skeleton className="h-4 w-1/3" />
					<Skeleton className="h-32 w-full" />
				</div>
			) : data ? (
				data.kind === "source" ? (
					<SourcePageView page={data} />
				) : (
					<EntityPageView page={data} />
				)
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Source pages (kind=source) — render the raw transcript / memory text
// prominently. These ARE the reference files that entity pages cite.
// ---------------------------------------------------------------------------

function SourcePageView({ page }: { page: WikiPageDetail }) {
	const fm = page.frontmatter ?? {};
	const sourceType = (fm.source_type as string | undefined) ?? "memory";
	const Icon = SOURCE_ICONS[sourceType] ?? FileText;
	const color = SOURCE_COLORS[sourceType] ?? "text-muted-foreground";

	return (
		<article className="space-y-6 max-w-5xl">
			<header className="space-y-2">
				<div className="flex items-center gap-3 flex-wrap">
					<Icon className={cn("size-5", color)} />
					<h1 className="text-2xl font-semibold">{page.title}</h1>
					<span
						className={cn(
							"text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium",
							color,
							"bg-muted/40",
						)}
					>
						{sourceType} source
					</span>
				</div>
				<div className="flex items-center gap-3 text-xs text-muted-foreground font-mono flex-wrap">
					<span>{page.slug}</span>
					{typeof fm.category === "string" && (
						<>
							<span>·</span>
							<span>category: {fm.category}</span>
						</>
					)}
					{typeof fm.local_session_id === "string" && (
						<>
							<span>·</span>
							<span>{fm.local_session_id}</span>
						</>
					)}
				</div>
			</header>

			{page.compiled_truth && (
				<section className="rounded-xl border bg-muted/30 overflow-hidden">
					<div className="px-4 py-2 border-b bg-muted/40 text-[11px] font-mono text-muted-foreground flex items-center justify-between">
						<span>Raw {sourceType}</span>
						<span>{page.compiled_truth.length.toLocaleString()} chars</span>
					</div>
					<pre className="p-4 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed text-foreground/90 max-h-[70vh] overflow-y-auto">
						{page.compiled_truth}
					</pre>
				</section>
			)}

			{page.backlinks.length > 0 && (
				<section className="space-y-3">
					<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Cited by {page.backlinks.length} entity page
						{page.backlinks.length === 1 ? "" : "s"}
					</h2>
					<ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
						{page.backlinks.map((l) => (
							<li key={l.id}>
								<Link
									href={`/wiki/${l.to_page_slug}`}
									className="block rounded-lg border bg-card p-3 hover:bg-accent/40 transition-colors"
								>
									<div className="font-medium text-sm">{l.to_page_title}</div>
									<div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
										{l.to_page_slug} · {l.link_type}
									</div>
								</Link>
							</li>
						))}
					</ul>
				</section>
			)}
		</article>
	);
}

// ---------------------------------------------------------------------------
// Entity pages (kind ∈ entity/concept/synthesis/...) — compiled_truth on top,
// then a Sources panel where each citation is a clickable card linking to its
// source page (mem-<id>/src-<id>).
// ---------------------------------------------------------------------------

function EntityPageView({ page }: { page: WikiPageDetail }) {
	const outgoingPageLinks = page.outgoing_links.filter((l) => l.to_page_id);
	const sourceLinks = page.outgoing_links.filter((l) => l.source_type);

	const sourcesByDomain = sourceLinks.reduce<Record<string, WikiLinkOut[]>>((acc, l) => {
		if (!l.source_type) return acc;
		const k = l.source_type;
		const bucket = acc[k] ?? [];
		bucket.push(l);
		acc[k] = bucket;
		return acc;
	}, {});

	return (
		<article className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-6">
			<div className="space-y-6 min-w-0">
				<header className="space-y-2">
					<div className="flex items-center gap-3 flex-wrap">
						<h1 className="text-3xl font-semibold">{page.title}</h1>
						<span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium bg-muted text-muted-foreground">
							{page.kind}
						</span>
						{page.stale && (
							<span className="text-[10px] px-2 py-0.5 rounded uppercase tracking-wide font-medium bg-orange-500/10 text-orange-700 dark:text-orange-400 inline-flex items-center gap-1">
								<AlertTriangle className="size-3" />
								Stale
							</span>
						)}
					</div>
					<div className="flex items-center gap-3 text-xs text-muted-foreground font-mono flex-wrap">
						<span>{page.slug}</span>
						<span>·</span>
						<span>
							{page.source_count} source{page.source_count === 1 ? "" : "s"}
						</span>
						{page.last_synthesis_at && (
							<>
								<span>·</span>
								<span className="inline-flex items-center gap-1">
									<Clock className="size-3" />
									synthesized {relativeTime(page.last_synthesis_at)}
								</span>
							</>
						)}
					</div>
				</header>

				<section className="rounded-xl border bg-card p-6">
					{page.compiled_truth ? (
						<div className="prose prose-sm dark:prose-invert max-w-none">
							<CompiledTruthBody body={page.compiled_truth} />
						</div>
					) : (
						<p className="text-sm text-muted-foreground italic">
							No synthesis yet — the synthesis pipeline runs after at least one source links to this
							page.
						</p>
					)}
				</section>

				{outgoingPageLinks.length > 0 && (
					<section className="space-y-2">
						<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1.5">
							<Link2 className="size-3.5" />
							Related pages
						</h2>
						<ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
							{outgoingPageLinks.map((l) => (
								<li key={l.id}>
									<Link
										href={`/wiki/${l.to_page_slug}`}
										className="block rounded-lg border bg-card p-3 hover:bg-accent/40 transition-colors"
									>
										<div className="text-sm font-medium">{l.to_page_title}</div>
										<div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
											{l.to_page_slug} · {l.link_type}
										</div>
									</Link>
								</li>
							))}
						</ul>
					</section>
				)}

				{page.backlinks.length > 0 && (
					<section className="space-y-2">
						<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							Linked from
						</h2>
						<ul className="space-y-1">
							{page.backlinks.map((l) => (
								<li key={l.id}>
									<Link
										href={`/wiki/${l.to_page_slug}`}
										className="text-sm hover:underline inline-flex items-center gap-2"
									>
										<span>← {l.to_page_title}</span>
										<span className="text-xs text-muted-foreground">({l.link_type})</span>
									</Link>
								</li>
							))}
						</ul>
					</section>
				)}
			</div>

			{/* Right rail — source pages, clickable, with kind icon. Mirrors the
			    nashsu/llm_wiki PreviewPanel concept: every source the page cites
			    is one click away in its raw form. */}
			{sourceLinks.length > 0 && (
				<aside className="space-y-3 lg:sticky lg:top-2 self-start">
					<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Source files
					</h2>
					<div className="space-y-3">
						{Object.entries(sourcesByDomain).map(([domain, links]) => {
							const Icon = SOURCE_ICONS[domain] ?? FileText;
							const color = SOURCE_COLORS[domain] ?? "text-muted-foreground";
							return (
								<div key={domain} className="space-y-1.5">
									<div
										className={cn(
											"text-[11px] font-medium inline-flex items-center gap-1.5",
											color,
										)}
									>
										<Icon className="size-3.5" />
										{domain} ({links.length})
									</div>
									<ul className="space-y-1">
										{links.map((l) => (
											<li key={l.id}>
												<SourceLinkCard link={l} />
											</li>
										))}
									</ul>
								</div>
							);
						})}
					</div>
				</aside>
			)}
		</article>
	);
}

function SourceLinkCard({ link }: { link: WikiLinkOut }) {
	if (link.source_page_slug) {
		return (
			<Link
				href={`/wiki/${link.source_page_slug}`}
				className="block rounded-md border bg-card p-2 hover:bg-accent/40 transition-colors"
			>
				<div className="text-xs font-medium leading-snug line-clamp-2">
					{link.source_page_title || link.source_page_slug}
				</div>
				<div className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">
					{link.source_page_slug}
					{link.confidence != null && (
						<span className="ml-1 opacity-70">· {Math.round(link.confidence * 100)}%</span>
					)}
				</div>
			</Link>
		);
	}
	// No source page exists for this ref (e.g. vault scope / skill). Render
	// the bare ref so the user still sees the citation; non-clickable.
	return (
		<div className="rounded-md border border-dashed bg-muted/20 p-2">
			<div className="text-[10px] text-muted-foreground font-mono break-all">{link.source_ref}</div>
		</div>
	);
}

function CompiledTruthBody({ body }: { body: string }) {
	const transformed = body.replace(/\[\[([^\]]+)\]\]/g, (_, raw: string) => {
		const target = raw.trim();
		const slug = target
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/[^a-z0-9-]/g, "");
		return `[${target}](/wiki/${slug})`;
	});
	return <Markdown content={transformed} />;
}
