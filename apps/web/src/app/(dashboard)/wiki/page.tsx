"use client";

import { Network } from "lucide-react";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// Graph is the wiki's default landing — the layer the user wants to see
// first. The actual sigma renderer lives in /wiki/graph/_graph-view.tsx
// (dynamic-import gated to avoid SSR WebGL crash).
const GraphView = dynamic(() => import("./graph/_graph-view"), {
	ssr: false,
	loading: () => (
		<div className="space-y-4">
			<header className="space-y-1">
				<div className="flex items-center gap-2">
					<Network className="size-6 text-muted-foreground" />
					<h1 className="text-2xl font-semibold">Graph</h1>
				</div>
			</header>
			<Skeleton className="h-[720px] w-full rounded-xl" />
		</div>
	),
});

export default function WikiHome() {
	return <GraphView />;
}
