"use client";

import type { ColumnDef, HeaderContext } from "@tanstack/react-table";
import Link from "next/link";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatAbsoluteTooltip, formatSessionSummary, relativeTime } from "@/lib/utils";

// Sortable header → reuse the project's `DataTableColumnHeader`
// shadcn primitive. Pre-fix this file rolled its own header (with
// slightly different spacing + a different "unsorted" indicator),
// drifting from the rest of the dashboard's tables. Wrapping it in
// `right`-aligned div for numeric columns to match the cell
// alignment of Messages/Tokens.
const sortableHeader =
	<TData,>(label: string, align: "left" | "right" = "left") =>
	({ column }: HeaderContext<TData, unknown>) => (
		<div className={align === "right" ? "flex justify-end" : undefined}>
			<DataTableColumnHeader column={column}>{label}</DataTableColumnHeader>
		</div>
	);

// Two flavours, shared cell renderers:
//   - `sessionColumns`: full table for /sessions, ~1080 px wide
//   - `sessionColumnsCompact`: 3-col cut for the Overview's "Recent
//     sessions" widget — drops Started / Messages / Tokens; keeps
//     Summary, Agent, Last activity (the three that answer "what /
//     where / when").
//
// Project lives folded INSIDE the Summary cell as secondary text
// (GitHub / Linear pattern: `repo/file.tsx`). Pre-r? layout had
// Project as its own column and there was no room left for a
// "Started" column when we added one. Folding releases ~140 px and
// ties project context to the row's primary identifier where the
// user's eye is already going.

const summaryColumn: ColumnDef<SessionListItem> = {
	id: "summary",
	accessorKey: "summary",
	header: "Summary",
	cell: ({ row }) => {
		const s = row.original;
		const title = formatSessionSummary(s.summary) || s.local_session_id.slice(0, 8);
		const projectFolder = s.project_path?.split("/").pop();
		return (
			<div className="min-w-0">
				<div className="truncate" title={title}>
					<Link
						href={`/sessions/${s.id}`}
						onClick={(e) => e.stopPropagation()}
						className="font-medium hover:underline"
					>
						{title}
					</Link>
				</div>
				{projectFolder ? (
					<div
						className="truncate text-xs text-muted-foreground"
						// Full path on hover — pre-fix the table dropped any
						// folder ancestry and showed only the leaf.
						title={s.project_path ?? undefined}
					>
						{projectFolder}
					</div>
				) : null}
			</div>
		);
	},
	size: 420,
};

const agentColumn: ColumnDef<SessionListItem> = {
	id: "agent",
	accessorFn: (s) => `${s.machine_name ?? ""} ${s.agent_type ?? ""}`,
	header: "Agent",
	cell: ({ row }) => (
		<AgentLabel machineName={row.original.machine_name} type={row.original.agent_type} size="sm" />
	),
	size: 180,
};

const startedColumn: ColumnDef<SessionListItem> = {
	id: "started_at",
	accessorKey: "started_at",
	enableSorting: true,
	header: sortableHeader<SessionListItem>("Started"),
	cell: ({ row }) => (
		<span
			className="whitespace-nowrap text-sm text-muted-foreground"
			title={formatAbsoluteTooltip(row.original.started_at)}
		>
			{relativeTime(row.original.started_at)}
		</span>
	),
	size: 110,
};

const lastActivityColumn: ColumnDef<SessionListItem> = {
	id: "last_activity_at",
	accessorKey: "last_activity_at",
	enableSorting: true,
	header: sortableHeader<SessionListItem>("Last activity"),
	cell: ({ row }) => (
		<span
			className="whitespace-nowrap text-sm text-muted-foreground"
			// Absolute timestamp on hover — pre-fix this was
			// `Started ${relativeTime(started_at)}`, a relative time
			// inside a tooltip whose whole job is to be precise.
			title={formatAbsoluteTooltip(row.original.last_activity_at)}
		>
			{relativeTime(row.original.last_activity_at)}
		</span>
	),
	size: 110,
};

const messagesColumn: ColumnDef<SessionListItem> = {
	id: "message_count",
	accessorFn: (s) => s.message_count,
	enableSorting: true,
	header: sortableHeader<SessionListItem>("Messages", "right"),
	cell: ({ row }) => (
		<span className="block text-right text-sm tabular-nums text-muted-foreground">
			{row.original.message_count}
		</span>
	),
	size: 90,
};

const tokensColumn: ColumnDef<SessionListItem> = {
	id: "tokens",
	accessorFn: (s) => s.input_tokens + s.output_tokens,
	enableSorting: true,
	header: sortableHeader<SessionListItem>("Tokens", "right"),
	cell: ({ row }) => {
		const total = row.original.input_tokens + row.original.output_tokens;
		return (
			<span className="block text-right text-sm tabular-nums text-muted-foreground">
				{(total / 1000).toFixed(1)}k
			</span>
		);
	},
	size: 90,
};

export const sessionColumns: ColumnDef<SessionListItem>[] = [
	summaryColumn,
	agentColumn,
	messagesColumn,
	tokensColumn,
	startedColumn,
	lastActivityColumn,
];

// Compact 3-col layout for the Overview "Recent sessions" widget.
// Sum of widths (~700) fits the half-width dashboard column without
// overflow. Headers are plain text — the parent widget doesn't wire
// up sort state, so a clickable sort affordance would be misleading.
const lastActivityColumnPlain: ColumnDef<SessionListItem> = {
	...lastActivityColumn,
	enableSorting: false,
	header: "Last activity",
};

export const sessionColumnsCompact: ColumnDef<SessionListItem>[] = [
	summaryColumn,
	agentColumn,
	lastActivityColumnPlain,
];
