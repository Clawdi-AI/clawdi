"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Laptop, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Memory } from "@/lib/api-schemas";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { cn, relativeTime } from "@/lib/utils";

// Memory table — content is the primary column (wrapped), type is a visual
// badge, tags are chip-style muted text. Source is intentionally omitted
// (it's almost always "manual" or "web"; shows on the detail page).
export function makeMemoryColumns(onDelete: (id: string) => void): ColumnDef<Memory>[] {
	return [
		{
			accessorKey: "content",
			enableSorting: false,
			header: () => <span className="text-sm font-medium">Memory</span>,
			cell: ({ row }) => {
				// Surface the source agent inline below the memory text
				// so users with multiple agents can tell which one
				// learned a fact without clicking through. Falls back
				// to a quiet "from a session" tag when the env that
				// owned the source session has been disconnected.
				const agentLabel = row.original.source_machine_name;
				const sessionId = row.original.source_session_id;
				return (
					<div className="space-y-1">
						<p className="whitespace-normal text-sm leading-relaxed">{row.original.content}</p>
						{agentLabel ? (
							<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
								<Laptop className="size-3" />
								Learned on {agentLabel}
							</span>
						) : sessionId ? (
							<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
								<Laptop className="size-3" />
								Learned from a session
							</span>
						) : null}
					</div>
				);
			},
			size: 560,
		},
		{
			id: "category",
			accessorKey: "category",
			enableSorting: false,
			header: () => <span className="text-sm font-medium">Type</span>,
			cell: ({ row }) => (
				<Badge variant="secondary" className={cn(MEMORY_CATEGORY_COLORS[row.original.category])}>
					{row.original.category}
				</Badge>
			),
			size: 110,
		},
		{
			id: "tags",
			accessorFn: (m) => m.tags?.join(" ") ?? "",
			enableSorting: false,
			header: () => <span className="text-sm font-medium">Tags</span>,
			cell: ({ row }) => {
				const tags = row.original.tags ?? [];
				const extra = tags.length - 3;
				return (
					<div className="flex flex-wrap gap-1">
						{tags.slice(0, 3).map((t) => (
							<span key={t} className="text-xs text-muted-foreground">
								#{t}
							</span>
						))}
						{extra > 0 ? (
							<span className="text-xs text-muted-foreground">+{extra} more</span>
						) : null}
					</div>
				);
			},
			size: 180,
		},
		{
			id: "created_at",
			accessorKey: "created_at",
			header: "Created",
			cell: ({ row }) =>
				row.original.created_at ? (
					<span className="whitespace-nowrap text-xs text-muted-foreground">
						{relativeTime(row.original.created_at)}
					</span>
				) : null,
			size: 110,
		},
		{
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			cell: ({ row }) => (
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={(e) => {
						e.stopPropagation();
						onDelete(row.original.id);
					}}
					className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
					aria-label="Delete memory"
				>
					<Trash2 className="size-3.5" />
				</Button>
			),
			size: 40,
		},
	];
}
