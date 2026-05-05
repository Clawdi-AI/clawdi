"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatAbsoluteTooltip, formatSessionSummary, relativeTime } from "@/lib/utils";

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
	header: ({ column }) => <DataTableColumnHeader column={column}>Started</DataTableColumnHeader>,
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
	header: ({ column }) => (
		<DataTableColumnHeader column={column}>Last activity</DataTableColumnHeader>
	),
	cell: ({ row }) => (
		<span
			className="whitespace-nowrap text-sm text-muted-foreground"
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
	header: ({ column }) => (
		<div className="flex justify-end">
			<DataTableColumnHeader column={column}>Messages</DataTableColumnHeader>
		</div>
	),
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
	header: ({ column }) => (
		<div className="flex justify-end">
			<DataTableColumnHeader column={column}>Tokens</DataTableColumnHeader>
		</div>
	),
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
