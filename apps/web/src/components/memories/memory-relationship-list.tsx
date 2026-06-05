"use client";

import { Brain, GitBranch, Laptop } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Memory } from "@/lib/api-schemas";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { memoryDetailHref } from "@/lib/project-resource-model";
import { cn, relativeTime } from "@/lib/utils";

export function MemoryRelationshipList({
	memories,
	isLoading,
	emptyMessage,
	limit,
}: {
	memories: Memory[];
	isLoading: boolean;
	emptyMessage: string;
	limit?: number;
}) {
	if (isLoading) {
		return (
			<div className="space-y-2">
				{Array.from({ length: 3 }).map((_, index) => (
					<Skeleton key={index} className="h-16 w-full" />
				))}
			</div>
		);
	}

	const visible = typeof limit === "number" ? memories.slice(0, limit) : memories;
	if (!visible.length) {
		return (
			<div className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
				{emptyMessage}
			</div>
		);
	}

	return (
		<div className="divide-y rounded-lg border bg-background/50">
			{visible.map((memory) => (
				<Link
					key={memory.id}
					href={memoryDetailHref(memory.id)}
					className="block px-3 py-3 transition-colors hover:bg-accent/50"
				>
					<div className="flex flex-wrap items-center gap-1.5">
						<Badge variant="secondary" className={cn(MEMORY_CATEGORY_COLORS[memory.category])}>
							{memory.category}
						</Badge>
						{memory.xtrace?.status ? (
							<span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">
								<GitBranch className="size-3" />
								{memory.xtrace.status}
							</span>
						) : null}
						{memory.created_at ? (
							<span className="text-xs text-muted-foreground">
								{relativeTime(memory.created_at)}
							</span>
						) : null}
					</div>
					<p className="mt-2 line-clamp-3 break-words text-sm leading-relaxed">{memory.content}</p>
					<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<span className="inline-flex items-center gap-1">
							<Brain className="size-3" />
							{memory.source}
						</span>
						{memory.source_machine_name ? (
							<span className="inline-flex items-center gap-1">
								<Laptop className="size-3" />
								{memory.source_machine_name}
							</span>
						) : null}
						{memory.source_session_id ? <span>source session</span> : null}
					</div>
				</Link>
			))}
			{typeof limit === "number" && memories.length > limit ? (
				<div className="px-3 py-2 text-xs text-muted-foreground">
					+{memories.length - limit} more
				</div>
			) : null}
		</div>
	);
}
