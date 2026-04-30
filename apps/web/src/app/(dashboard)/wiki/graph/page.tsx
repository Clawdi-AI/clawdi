"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Network } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
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

type WikiLinkOut = {
	id: string;
	link_type: string;
	confidence: number | null;
	to_page_id: string | null;
	to_page_slug: string | null;
	to_page_title: string | null;
	source_type: string | null;
	source_ref: string | null;
};

type WikiPageDetail = {
	id: string;
	slug: string;
	title: string;
	source_count: number;
	outgoing_links: WikiLinkOut[];
	backlinks: WikiLinkOut[];
};

type PageList = {
	items: WikiPageSummary[];
	total: number;
};

// SVG canvas dimensions
const W = 900;
const H = 720;
const HUB_RADIUS_BASE = 25;
const NEIGHBOR_RADIUS = 14;

/**
 * Layout: hub-and-spoke around the top-N entities by source_count.
 * For each hub, place direct neighbors (page-to-page co-occurs edges) on
 * a ring around it. Hubs are themselves arranged on an outer ring.
 *
 * No physics simulation — purely deterministic geometry. Good enough for
 * 8-12 hubs + their immediate neighbors. For richer layouts we'd swap in
 * d3-force or vis-network.
 */
export default function WikiGraphPage() {
	const { getToken } = useAuth();

	const { data: pageList, isLoading: listLoading } = useQuery<PageList>({
		queryKey: ["wiki", "graph", "top"],
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			return apiFetch<PageList>("/api/wiki/pages?page_size=12&sort=source_count&order=desc", token);
		},
	});

	const topSlugs = pageList?.items.map((p) => p.slug) ?? [];

	const detailQueries = useQuery<WikiPageDetail[]>({
		queryKey: ["wiki", "graph", "details", topSlugs],
		enabled: topSlugs.length > 0,
		queryFn: async () => {
			const token = (await getToken()) ?? "";
			return Promise.all(
				topSlugs.map((s) =>
					apiFetch<WikiPageDetail>(`/api/wiki/pages/${encodeURIComponent(s)}`, token),
				),
			);
		},
	});

	const layout = useMemo(() => {
		const details = detailQueries.data;
		if (!details || details.length === 0) return null;

		const hubs = details.slice(0, 8); // up to 8 hubs to keep it readable
		const hubCount = hubs.length;
		const hubRingRadius = 240;
		const cx = W / 2;
		const cy = H / 2;

		type Node = {
			slug: string;
			title: string;
			x: number;
			y: number;
			r: number;
			isHub: boolean;
			source_count: number;
		};
		type Edge = { from: string; to: string };

		const nodes: Map<string, Node> = new Map();
		const edges: Edge[] = [];

		// Place hubs evenly on a ring
		hubs.forEach((hub, i) => {
			const angle = (i / hubCount) * 2 * Math.PI - Math.PI / 2;
			const hx = cx + hubRingRadius * Math.cos(angle);
			const hy = cy + hubRingRadius * Math.sin(angle);
			const radius = HUB_RADIUS_BASE + Math.min(15, hub.source_count / 4);
			nodes.set(hub.slug, {
				slug: hub.slug,
				title: hub.title,
				x: hx,
				y: hy,
				r: radius,
				isHub: true,
				source_count: hub.source_count,
			});
		});

		// For each hub, place top neighbors (page-to-page edges) on a ring around it
		hubs.forEach((hub, i) => {
			const hubNode = nodes.get(hub.slug);
			if (!hubNode) return;
			const pageEdges = hub.outgoing_links
				.filter((l) => l.to_page_slug && l.link_type === "co-occurs")
				.slice(0, 6); // 6 neighbors per hub max
			pageEdges.forEach((edge, j) => {
				const neighborSlug = edge.to_page_slug as string;
				edges.push({ from: hub.slug, to: neighborSlug });

				if (nodes.has(neighborSlug)) return;
				const baseAngle = (i / hubCount) * 2 * Math.PI - Math.PI / 2;
				const neighborSpread = (Math.PI / 3) * (j / Math.max(1, pageEdges.length - 1) - 0.5);
				const angle = baseAngle + neighborSpread;
				const distance = 110;
				nodes.set(neighborSlug, {
					slug: neighborSlug,
					title: edge.to_page_title || neighborSlug,
					x: hubNode.x + distance * Math.cos(angle),
					y: hubNode.y + distance * Math.sin(angle),
					r: NEIGHBOR_RADIUS,
					isHub: false,
					source_count: 0,
				});
			});
		});

		return { nodes: Array.from(nodes.values()), edges };
	}, [detailQueries.data]);

	const isLoading = listLoading || detailQueries.isLoading;

	return (
		<div className="max-w-6xl mx-auto space-y-6">
			<Link
				href="/wiki"
				className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
			>
				<ArrowLeft className="size-4" />
				Back to wiki
			</Link>

			<header className="space-y-2">
				<div className="flex items-center gap-2">
					<Network className="size-6 text-muted-foreground" />
					<h1 className="text-2xl font-semibold">Graph</h1>
				</div>
				<p className="text-sm text-muted-foreground max-w-prose">
					Top-8 entities by source count, with their direct co-occurrence neighbors. Hub size scales
					with source count. Click any node to open its page.
				</p>
			</header>

			{isLoading ? (
				<Skeleton className="h-[720px] w-full rounded-xl" />
			) : !layout || layout.nodes.length === 0 ? (
				<div className="rounded-xl border border-dashed bg-card/50 p-10 text-center text-muted-foreground">
					<Network className="size-10 mx-auto mb-4 opacity-50" />
					<p>No graph data yet. Run extraction + recompute-graph first.</p>
				</div>
			) : (
				<div className="rounded-xl border bg-card overflow-hidden">
					<svg
						viewBox={`0 0 ${W} ${H}`}
						className="w-full h-auto"
						style={{ background: "transparent" }}
					>
						<title>Wiki knowledge graph</title>
						{/* Edges */}
						{layout.edges.map((e, idx) => {
							const from = layout.nodes.find((n) => n.slug === e.from);
							const to = layout.nodes.find((n) => n.slug === e.to);
							if (!from || !to) return null;
							return (
								<line
									key={`${e.from}-${e.to}-${idx}`}
									x1={from.x}
									y1={from.y}
									x2={to.x}
									y2={to.y}
									stroke="currentColor"
									strokeOpacity={0.18}
									strokeWidth={1}
									className="text-muted-foreground"
								/>
							);
						})}
						{/* Nodes */}
						{layout.nodes.map((n) => (
							<a key={n.slug} href={`/wiki/${n.slug}`}>
								<g className="cursor-pointer">
									<circle
										cx={n.x}
										cy={n.y}
										r={n.r}
										fill={n.isHub ? "hsl(var(--primary))" : "hsl(var(--card))"}
										stroke="currentColor"
										strokeOpacity={n.isHub ? 0.8 : 0.3}
										strokeWidth={n.isHub ? 2 : 1}
										className={cn(
											"transition-opacity hover:opacity-80",
											n.isHub ? "text-primary" : "text-muted-foreground",
										)}
									/>
									<text
										x={n.x}
										y={n.y + n.r + 14}
										textAnchor="middle"
										className={cn(
											"text-xs select-none pointer-events-none",
											n.isHub ? "font-medium fill-foreground" : "fill-muted-foreground",
										)}
									>
										{n.title.length > 18 ? `${n.title.slice(0, 16)}…` : n.title}
									</text>
									{n.isHub && (
										<text
											x={n.x}
											y={n.y + 4}
											textAnchor="middle"
											className="text-[10px] fill-primary-foreground font-mono select-none pointer-events-none"
										>
											{n.source_count}
										</text>
									)}
								</g>
							</a>
						))}
					</svg>
				</div>
			)}
		</div>
	);
}
