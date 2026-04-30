"use client";

import { Network } from "lucide-react";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

const GraphView = dynamic(() => import("./_graph-view"), {
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

export default function WikiGraphPage() {
	return <GraphView />;
}
