"use client";

import "@react-sigma/core/lib/style.css";

import { useAuth } from "@clerk/nextjs";
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from "@react-sigma/core";
import { useQuery } from "@tanstack/react-query";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { Network } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";

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

type GraphResponse = {
	nodes: GraphNode[];
	edges: GraphEdge[];
};

const NODE_KIND_COLORS: Record<string, string> = {
	entity: "#6366f1", // indigo
	synthesis: "#a855f7", // violet
	concept: "#14b8a6", // teal
	source: "#94a3b8", // slate
};

const EDGE_TYPE_COLORS: Record<string, string> = {
	"co-occurs": "#cbd5e1",
	mentions: "#cbd5e1",
	references: "#94a3b8",
	uses: "#64748b",
	"depends-on": "#475569",
	defines: "#475569",
	"related-to": "#94a3b8",
};

const BASE_NODE_SIZE = 4;
const MAX_NODE_SIZE = 22;

function GraphLoader({ data }: { data: GraphResponse }) {
	const loadGraph = useLoadGraph();

	useEffect(() => {
		const graph = new Graph({ multi: false, type: "undirected" });
		const maxSources = Math.max(1, ...data.nodes.map((n) => n.source_count));

		// Seed each node at a small random position so ForceAtlas2 has
		// something to spread; without a seed the layout collapses to origin.
		data.nodes.forEach((n) => {
			const size =
				BASE_NODE_SIZE + (MAX_NODE_SIZE - BASE_NODE_SIZE) * Math.sqrt(n.source_count / maxSources);
			graph.addNode(n.id, {
				label: n.title,
				size,
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

		// Run ForceAtlas2 in-place. Degree-scaled gravity prevents disconnected
		// nodes from drifting off-canvas; scaling keeps tightly-connected
		// clusters from overlapping. 300 iters is enough for graphs up to ~200
		// nodes; bump if we ever raise the node cap.
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
	}, [data, loadGraph]);

	return null;
}

function GraphEvents() {
	const sigma = useSigma();
	const registerEvents = useRegisterEvents();
	const router = useRouter();

	useEffect(() => {
		registerEvents({
			clickNode: (event) => {
				router.push(`/wiki/${event.node}`);
			},
			enterNode: (event) => {
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
	}, [registerEvents, sigma, router]);

	return null;
}

export default function WikiGraphPage() {
	const { getToken } = useAuth();

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

	return (
		<div className="space-y-4">
			<header className="space-y-1">
				<div className="flex items-center gap-2">
					<Network className="size-6 text-muted-foreground" />
					<h1 className="text-2xl font-semibold">Graph</h1>
				</div>
				<p className="text-sm text-muted-foreground">
					Force-directed knowledge graph — every entity page and the wikilinks between them. Node
					size scales with source count; color encodes page kind. Hover to highlight neighbors,
					click to open.
				</p>
				{!isLoading && !empty && (
					<p className="text-xs text-muted-foreground font-mono">
						{nodeCount} nodes · {edgeCount} edges
					</p>
				)}
			</header>

			{isLoading ? (
				<Skeleton className="h-[720px] w-full rounded-xl" />
			) : empty ? (
				<div className="rounded-xl border border-dashed bg-card/50 p-10 text-center text-muted-foreground">
					<Network className="size-10 mx-auto mb-4 opacity-50" />
					<p>No graph data yet. Run extraction + recompute-graph first.</p>
				</div>
			) : (
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
						<GraphLoader data={data as GraphResponse} />
						<GraphEvents />
					</SigmaContainer>
				</div>
			)}

			<div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
				<LegendDot color={NODE_KIND_COLORS.entity} label="entity" />
				<LegendDot color={NODE_KIND_COLORS.synthesis} label="synthesis" />
				<LegendDot color={NODE_KIND_COLORS.concept} label="concept" />
				<LegendDot color={NODE_KIND_COLORS.source} label="source" />
			</div>
		</div>
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
