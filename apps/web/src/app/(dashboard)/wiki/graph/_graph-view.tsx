"use client";

import "@react-sigma/core/lib/style.css";

import { useAuth } from "@clerk/nextjs";
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from "@react-sigma/core";
import { useQuery } from "@tanstack/react-query";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";
import {
	AlertTriangle,
	Brain,
	Clock,
	ExternalLink,
	FileText,
	Key,
	Link2,
	Network,
	Sparkles,
	X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types — keep aligned with backend GraphResponse / WikiPageDetail
// ---------------------------------------------------------------------------

type GraphNode = {
	id: string;
	title: string;
	kind: string;
	source_count: number;
};
type GraphEdge = {
	source: string;
	target: string;
	link_type: string;
	weight: number;
};
type GraphResponse = { nodes: GraphNode[]; edges: GraphEdge[] };

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

const NODE_KIND_COLORS: Record<string, string> = {
	entity: "#6366f1",
	synthesis: "#a855f7",
	concept: "#14b8a6",
	source: "#94a3b8",
};

// 12-color palette for Louvain community coloring. Same intent as
// nashsu/llm_wiki's COMMUNITY_COLORS — picked-by-eye to be perceptually
// distinct and reasonable in dark mode.
const COMMUNITY_COLORS = [
	"#6366f1", // indigo
	"#ec4899", // pink
	"#14b8a6", // teal
	"#f97316", // orange
	"#a855f7", // violet
	"#22c55e", // green
	"#ef4444", // red
	"#06b6d4", // cyan
	"#eab308", // yellow
	"#84cc16", // lime
	"#f43f5e", // rose
	"#3b82f6", // blue
];

type ColorMode = "kind" | "community";

const EDGE_TYPE_COLORS: Record<string, string> = {
	"co-occurs": "#cbd5e1",
	mentions: "#cbd5e1",
	references: "#94a3b8",
	uses: "#64748b",
	"depends-on": "#475569",
	defines: "#475569",
	"related-to": "#94a3b8",
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

const BASE_NODE_SIZE = 4;
const MAX_NODE_SIZE = 22;

// ---------------------------------------------------------------------------
// Sigma graph wiring
// ---------------------------------------------------------------------------

function GraphLoader({ data, colorMode }: { data: GraphResponse; colorMode: ColorMode }) {
	const loadGraph = useLoadGraph();
	useEffect(() => {
		const graph = new Graph({ multi: false, type: "undirected" });
		const maxSources = Math.max(1, ...data.nodes.map((n) => n.source_count));
		data.nodes.forEach((n) => {
			const size =
				BASE_NODE_SIZE + (MAX_NODE_SIZE - BASE_NODE_SIZE) * Math.sqrt(n.source_count / maxSources);
			graph.addNode(n.id, {
				label: n.title,
				size,
				// Initial fill — overwritten below once we know the community.
				color: NODE_KIND_COLORS[n.kind] ?? "#9ca3af",
				x: Math.random(),
				y: Math.random(),
				kind: n.kind,
				source_count: n.source_count,
			});
		});
		data.edges.forEach((e, idx) => {
			if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) return;
			if (graph.hasEdge(e.source, e.target)) return;
			graph.addEdgeWithKey(`e${idx}`, e.source, e.target, {
				color: EDGE_TYPE_COLORS[e.link_type] ?? "#cbd5e1",
				size: Math.max(0.5, e.weight * 3),
				type: "line",
				link_type: e.link_type,
			});
		});

		// Louvain community detection — group densely-connected nodes so the
		// "color by community" mode shows real clusters (e.g. voice-agent +
		// twilio + openclaw all share a community). Resolution > 1 splits
		// finer; default works well for ~200-node personal wikis.
		try {
			louvain.assign(graph, { resolution: 1 });
		} catch {
			// Graph too sparse / disconnected — fall back to assigning every
			// node its own community so the palette still cycles cleanly.
			let i = 0;
			graph.forEachNode((node) => {
				graph.setNodeAttribute(node, "community", i++);
			});
		}

		// Apply the chosen color palette now that community is assigned.
		graph.forEachNode((node, attrs) => {
			const c =
				colorMode === "community"
					? COMMUNITY_COLORS[((attrs.community as number) ?? 0) % COMMUNITY_COLORS.length]
					: (NODE_KIND_COLORS[attrs.kind as string] ?? "#9ca3af");
			graph.setNodeAttribute(node, "color", c);
			// Save the resolved color for the hover/select dim-and-restore logic.
			graph.setNodeAttribute(node, "_origColor", c);
		});

		const settings = forceAtlas2.inferSettings(graph);
		forceAtlas2.assign(graph, {
			iterations: 300,
			settings: {
				...settings,
				gravity: 1.5,
				scalingRatio: 8,
				adjustSizes: true,
				barnesHutOptimize: graph.order > 100,
			},
		});
		loadGraph(graph);
	}, [data, colorMode, loadGraph]);
	return null;
}

/**
 * Reflects the externally-driven `selectedSlug` onto the canvas: highlights
 * the matching node + its neighbors, dims everything else, and centers the
 * camera. Mirrors nashsu/llm_wiki's insight-highlight behavior so clicking
 * a sidebar entry tells you _where_ that entity sits in the graph.
 */
function SelectionEffect({ selectedSlug }: { selectedSlug: string | null }) {
	const sigma = useSigma();
	useEffect(() => {
		const graph = sigma.getGraph();
		if (!selectedSlug || !graph.hasNode(selectedSlug)) {
			// Reset: restore every node/edge to its base color and uniform size.
			graph.forEachNode((node, attrs) => {
				if (attrs._origColor) graph.setNodeAttribute(node, "color", attrs._origColor);
				graph.setNodeAttribute(node, "highlighted", false);
				if (attrs._origSize != null) {
					graph.setNodeAttribute(node, "size", attrs._origSize);
					graph.removeNodeAttribute(node, "_origSize");
				}
			});
			graph.forEachEdge((edge, attrs) => {
				if (attrs._origColor) graph.setEdgeAttribute(edge, "color", attrs._origColor);
			});
			sigma.refresh();
			return;
		}

		const neighbors = new Set<string>([selectedSlug, ...graph.neighbors(selectedSlug)]);
		graph.forEachNode((node, attrs) => {
			const inFocus = neighbors.has(node);
			graph.setNodeAttribute(node, "_origColor", attrs._origColor ?? attrs.color);
			graph.setNodeAttribute(
				node,
				"color",
				inFocus ? ((attrs._origColor as string | undefined) ?? attrs.color) : "#e5e7eb",
			);
			graph.setNodeAttribute(node, "highlighted", node === selectedSlug);
			if (node === selectedSlug) {
				graph.setNodeAttribute(node, "_origSize", attrs._origSize ?? attrs.size);
				graph.setNodeAttribute(node, "size", (attrs.size as number) * 1.5);
			}
		});
		graph.forEachEdge((edge, attrs, src, dst) => {
			graph.setEdgeAttribute(edge, "_origColor", attrs._origColor ?? attrs.color);
			const involved = src === selectedSlug || dst === selectedSlug;
			graph.setEdgeAttribute(edge, "color", involved ? "#475569" : "#f1f5f9");
		});

		// Smoothly pan + zoom to the selected node.
		const pos = sigma.getNodeDisplayData(selectedSlug);
		if (pos) {
			sigma.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.6 }, { duration: 400 });
		}
		sigma.refresh();
	}, [selectedSlug, sigma]);
	return null;
}

function GraphEvents({
	onSelect,
	selectedSlug,
}: {
	onSelect: (slug: string) => void;
	selectedSlug: string | null;
}) {
	const sigma = useSigma();
	const registerEvents = useRegisterEvents();

	useEffect(() => {
		registerEvents({
			clickNode: (event) => {
				// Render the page in the side panel instead of navigating away.
				onSelect(event.node);
			},
			enterNode: (event) => {
				// When a node is selected, SelectionEffect owns the dim/focus
				// state. Skipping hover effects here avoids a tug-of-war that
				// drops the selection's dim on every cursor move.
				if (selectedSlug) return;
				const graph = sigma.getGraph();
				const hovered = event.node;
				const neighbors = new Set([hovered, ...graph.neighbors(hovered)]);
				graph.forEachNode((node, attrs) => {
					graph.setNodeAttribute(node, "highlighted", neighbors.has(node));
					graph.setNodeAttribute(node, "_origColor", attrs._origColor ?? attrs.color);
					graph.setNodeAttribute(
						node,
						"color",
						neighbors.has(node) ? (attrs._origColor ?? attrs.color) : "#e5e7eb",
					);
				});
				graph.forEachEdge((edge, attrs, src, dst) => {
					graph.setEdgeAttribute(edge, "_origColor", attrs._origColor ?? attrs.color);
					const involved = src === hovered || dst === hovered;
					graph.setEdgeAttribute(edge, "color", involved ? "#475569" : "#f1f5f9");
				});
				sigma.refresh();
			},
			leaveNode: () => {
				if (selectedSlug) return;
				const graph = sigma.getGraph();
				graph.forEachNode((node, attrs) => {
					if (attrs._origColor) graph.setNodeAttribute(node, "color", attrs._origColor);
					graph.setNodeAttribute(node, "highlighted", false);
				});
				graph.forEachEdge((edge, attrs) => {
					if (attrs._origColor) graph.setEdgeAttribute(edge, "color", attrs._origColor);
				});
				sigma.refresh();
			},
		});
	}, [registerEvents, sigma, onSelect, selectedSlug]);

	return null;
}

// ---------------------------------------------------------------------------
// Main view — graph + side panel
// ---------------------------------------------------------------------------

export default function WikiGraphView() {
	const { getToken } = useAuth();
	const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
	const [colorMode, setColorMode] = useState<ColorMode>("kind");

	const { data, isLoading } = useQuery<GraphResponse>({
		queryKey: ["wiki", "graph", "full"],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			return apiFetch<GraphResponse>("/api/wiki/graph?limit=200", token);
		},
	});

	const nodeCount = data?.nodes.length ?? 0;
	const edgeCount = data?.edges.length ?? 0;
	const empty = !isLoading && nodeCount === 0;

	const handleSelect = useCallback((slug: string) => setSelectedSlug(slug), []);
	const handleClose = useCallback(() => setSelectedSlug(null), []);

	return (
		<div className="space-y-4">
			<header className="flex items-start justify-between gap-4 flex-wrap">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<Network className="size-6 text-muted-foreground" />
						<h1 className="text-2xl font-semibold">Graph</h1>
					</div>
					<p className="text-sm text-muted-foreground">
						Force-directed knowledge graph — every entity page and the wikilinks between them. Node
						size scales with source count; color encodes page kind. Hover to highlight neighbors,
						click to preview.
					</p>
					{!isLoading && !empty && (
						<p className="text-xs text-muted-foreground font-mono">
							{nodeCount} nodes · {edgeCount} edges
						</p>
					)}
				</div>
				<div className="flex items-start gap-4 flex-wrap">
					<div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5 text-xs">
						<button
							type="button"
							onClick={() => setColorMode("kind")}
							className={cn(
								"px-2.5 py-1 rounded-md font-medium transition-colors",
								colorMode === "kind"
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							by kind
						</button>
						<button
							type="button"
							onClick={() => setColorMode("community")}
							className={cn(
								"px-2.5 py-1 rounded-md font-medium transition-colors",
								colorMode === "community"
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							by cluster
						</button>
					</div>
					{colorMode === "kind" ? (
						<div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
							<LegendDot color={NODE_KIND_COLORS.entity} label="entity" />
							<LegendDot color={NODE_KIND_COLORS.synthesis} label="synthesis" />
							<LegendDot color={NODE_KIND_COLORS.concept} label="concept" />
							<LegendDot color={NODE_KIND_COLORS.source} label="source" />
						</div>
					) : (
						<div className="text-xs text-muted-foreground">
							Louvain communities · {COMMUNITY_COLORS.length} colors cycle
						</div>
					)}
				</div>
			</header>

			{isLoading ? (
				<Skeleton className="h-[720px] w-full rounded-xl" />
			) : empty ? (
				<div className="rounded-xl border border-dashed bg-card/50 p-10 text-center text-muted-foreground">
					<Network className="size-10 mx-auto mb-4 opacity-50" />
					<p>No graph data yet. Run extraction + recompute-graph first.</p>
				</div>
			) : (
				<div
					className={cn(
						"grid gap-4 transition-all",
						selectedSlug ? "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_28rem]" : "grid-cols-1",
					)}
				>
					<div className="rounded-xl border bg-card overflow-hidden h-[720px]">
						<SigmaContainer
							style={{ height: "100%", width: "100%", background: "transparent" }}
							settings={{
								renderLabels: true,
								labelDensity: 0.7,
								labelGridCellSize: 60,
								labelRenderedSizeThreshold: 8,
								defaultEdgeColor: "#cbd5e1",
								defaultNodeColor: "#9ca3af",
								zIndex: true,
							}}
						>
							<GraphLoader data={data as GraphResponse} colorMode={colorMode} />
							<GraphEvents onSelect={handleSelect} selectedSlug={selectedSlug} />
							<SelectionEffect selectedSlug={selectedSlug} />
						</SigmaContainer>
					</div>

					{selectedSlug && (
						<aside className="rounded-xl border bg-card h-[720px] flex flex-col overflow-hidden">
							<PagePanel slug={selectedSlug} onSelect={handleSelect} onClose={handleClose} />
						</aside>
					)}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Side-panel page renderer — used for both entity and source pages
// ---------------------------------------------------------------------------

function PagePanel({
	slug,
	onSelect,
	onClose,
}: {
	slug: string;
	onSelect: (slug: string) => void;
	onClose: () => void;
}) {
	const { getToken } = useAuth();

	const { data, isLoading, error } = useQuery<WikiPageDetail>({
		queryKey: ["wiki", "page", slug],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			return apiFetch<WikiPageDetail>(`/api/wiki/pages/${encodeURIComponent(slug)}`, token);
		},
		retry: (count, err: Error) => !err.message.includes("404") && count < 2,
	});

	return (
		<>
			<header className="flex items-center justify-between gap-2 px-4 py-2.5 border-b shrink-0">
				<div className="text-xs font-mono text-muted-foreground truncate">{slug}</div>
				<div className="flex items-center gap-1 shrink-0">
					<Link
						href={`/wiki/${slug}`}
						className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
						title="Open in full page"
					>
						<ExternalLink className="size-3.5" />
					</Link>
					<button
						type="button"
						onClick={onClose}
						className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
						title="Close panel"
					>
						<X className="size-4" />
					</button>
				</div>
			</header>

			<div className="flex-1 overflow-y-auto px-4 py-4">
				{isLoading ? (
					<div className="space-y-3">
						<Skeleton className="h-6 w-2/3" />
						<Skeleton className="h-3 w-1/3" />
						<Skeleton className="h-24 w-full" />
					</div>
				) : error?.message.includes("404") ? (
					<div className="text-sm text-muted-foreground">
						Page not found: <code className="font-mono">{slug}</code>
					</div>
				) : data ? (
					data.kind === "source" ? (
						<SourceContent page={data} onSelect={onSelect} />
					) : (
						<EntityContent page={data} onSelect={onSelect} />
					)
				) : null}
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// Entity content (compiled_truth + clickable sources + related/backlinks)
// All cross-page links route through onSelect so the user stays in the
// graph view; the side panel just swaps content.
// ---------------------------------------------------------------------------

function EntityContent({
	page,
	onSelect,
}: {
	page: WikiPageDetail;
	onSelect: (slug: string) => void;
}) {
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
		<article className="space-y-5">
			<header className="space-y-2">
				<div className="flex items-center gap-2 flex-wrap">
					<h2 className="text-xl font-semibold leading-tight">{page.title}</h2>
					<span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium bg-muted text-muted-foreground">
						{page.kind}
					</span>
					{page.stale && (
						<span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium bg-orange-500/10 text-orange-700 dark:text-orange-400 inline-flex items-center gap-1">
							<AlertTriangle className="size-3" />
							Stale
						</span>
					)}
				</div>
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono flex-wrap">
					<span>
						{page.source_count} src{page.source_count === 1 ? "" : "s"}
					</span>
					{page.last_synthesis_at && (
						<>
							<span>·</span>
							<span className="inline-flex items-center gap-1">
								<Clock className="size-3" />
								{relativeTime(page.last_synthesis_at)}
							</span>
						</>
					)}
				</div>
			</header>

			{page.compiled_truth ? (
				<div className="prose prose-sm dark:prose-invert max-w-none">
					<Markdown
						content={page.compiled_truth.replace(/\[\[([^\]]+)\]\]/g, (_, raw: string) => {
							const target = raw.trim();
							const slug = target
								.toLowerCase()
								.replace(/\s+/g, "-")
								.replace(/[^a-z0-9-]/g, "");
							return `[${target}](/wiki/${slug})`;
						})}
					/>
				</div>
			) : (
				<p className="text-sm text-muted-foreground italic">No synthesis yet.</p>
			)}

			{sourceLinks.length > 0 && (
				<section className="space-y-2">
					<h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						Source files
					</h3>
					{Object.entries(sourcesByDomain).map(([domain, links]) => {
						const Icon = SOURCE_ICONS[domain] ?? FileText;
						const color = SOURCE_COLORS[domain] ?? "text-muted-foreground";
						return (
							<div key={domain} className="space-y-1.5">
								<div
									className={cn("text-[11px] font-medium inline-flex items-center gap-1.5", color)}
								>
									<Icon className="size-3.5" />
									{domain} ({links.length})
								</div>
								<ul className="space-y-1">
									{links.map((l) => (
										<li key={l.id}>
											{l.source_page_slug ? (
												<button
													type="button"
													onClick={() => onSelect(l.source_page_slug as string)}
													className="w-full text-left rounded-md border bg-background hover:bg-accent/40 transition-colors p-2"
												>
													<div className="text-xs font-medium leading-snug line-clamp-2">
														{l.source_page_title || l.source_page_slug}
													</div>
													<div className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">
														{l.source_page_slug}
													</div>
												</button>
											) : (
												<div className="rounded-md border border-dashed bg-muted/20 p-2">
													<div className="text-[10px] text-muted-foreground font-mono break-all">
														{l.source_ref}
													</div>
												</div>
											)}
										</li>
									))}
								</ul>
							</div>
						);
					})}
				</section>
			)}

			{outgoingPageLinks.length > 0 && (
				<section className="space-y-2">
					<h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
						<Link2 className="size-3" />
						Related
					</h3>
					<ul className="space-y-1">
						{outgoingPageLinks.map((l) => (
							<li key={l.id}>
								<button
									type="button"
									onClick={() => l.to_page_slug && onSelect(l.to_page_slug)}
									className="w-full text-left rounded-md border bg-background hover:bg-accent/40 transition-colors p-2"
								>
									<div className="text-xs font-medium leading-snug">{l.to_page_title}</div>
									<div className="text-[10px] text-muted-foreground mt-0.5">{l.link_type}</div>
								</button>
							</li>
						))}
					</ul>
				</section>
			)}

			{page.backlinks.length > 0 && (
				<section className="space-y-2">
					<h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						Linked from
					</h3>
					<ul className="space-y-1">
						{page.backlinks.map((l) => (
							<li key={l.id}>
								<button
									type="button"
									onClick={() => l.to_page_slug && onSelect(l.to_page_slug)}
									className="text-xs hover:underline text-left"
								>
									← {l.to_page_title} <span className="text-muted-foreground">({l.link_type})</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</article>
	);
}

// ---------------------------------------------------------------------------
// Source content — raw transcript / memory text in monospace, plus backlinks.
// ---------------------------------------------------------------------------

function SourceContent({
	page,
	onSelect,
}: {
	page: WikiPageDetail;
	onSelect: (slug: string) => void;
}) {
	const fm = page.frontmatter ?? {};
	const sourceType = (fm.source_type as string | undefined) ?? "memory";
	const Icon = SOURCE_ICONS[sourceType] ?? FileText;
	const color = SOURCE_COLORS[sourceType] ?? "text-muted-foreground";

	return (
		<article className="space-y-4">
			<header className="space-y-2">
				<div className="flex items-center gap-2 flex-wrap">
					<Icon className={cn("size-4", color)} />
					<h2 className="text-base font-semibold leading-snug break-words">{page.title}</h2>
				</div>
				<div className="text-[11px] text-muted-foreground font-mono flex flex-wrap gap-x-3 gap-y-0.5">
					<span>{sourceType} source</span>
					{typeof fm.category === "string" && <span>category: {fm.category}</span>}
					{typeof fm.local_session_id === "string" && <span>{fm.local_session_id}</span>}
				</div>
			</header>

			{page.compiled_truth && (
				<section className="rounded-lg border bg-muted/30 overflow-hidden">
					<div className="px-3 py-1.5 border-b bg-muted/40 text-[10px] font-mono text-muted-foreground flex items-center justify-between">
						<span>Raw {sourceType}</span>
						<span>{page.compiled_truth.length.toLocaleString()} chars</span>
					</div>
					<pre className="px-3 py-2 text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
						{page.compiled_truth}
					</pre>
				</section>
			)}

			{page.backlinks.length > 0 && (
				<section className="space-y-1">
					<h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						Cited by {page.backlinks.length} page{page.backlinks.length === 1 ? "" : "s"}
					</h3>
					<ul className="space-y-1">
						{page.backlinks.map((l) => (
							<li key={l.id}>
								<button
									type="button"
									onClick={() => l.to_page_slug && onSelect(l.to_page_slug)}
									className="text-xs hover:underline text-left"
								>
									<span className="text-muted-foreground">←</span> {l.to_page_title}{" "}
									<span className="text-[10px] text-muted-foreground font-mono">
										{l.to_page_slug}
									</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</article>
	);
}

function LegendDot({ color, label }: { color: string; label: string }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="inline-block size-2.5 rounded-full" style={{ backgroundColor: color }} />
			{label}
		</span>
	);
}
