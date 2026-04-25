"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { AgentLabel } from "@/components/dashboard/agent-label";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatSessionSummary, relativeTime } from "@/lib/utils";

// Two flavours, shared cell renderers:
//   - `sessionColumns`: full table for /sessions, ~1070 px wide
//   - `sessionColumnsCompact`: 3-col cut for the Overview's "Recent
//     sessions" widget, ~700 px — fits the half-width dashboard column
//     without horizontal scroll. Drops Project/Messages/Tokens; keeps
//     Summary, Agent, Started (the three that answer "what / where / when").
//
// The "Agent" column pairs agent type with machine name (e.g.
// "Claude Code · kingsley-mbp") — an agent without its host is useless
// context for a multi-machine user.

const summaryColumn: ColumnDef<SessionListItem> = {
	id: "summary",
	accessorKey: "summary",
	header: "Summary",
	cell: ({ row }) => {
		const s = row.original;
		const title = formatSessionSummary(s.summary) || s.local_session_id.slice(0, 8);
		return (
			<div className="truncate" title={title}>
				<Link
					href={`/sessions/${s.id}`}
					onClick={(e) => e.stopPropagation()}
					className="font-medium hover:underline"
				>
					{title}
				</Link>
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
	header: "Started",
	cell: ({ row }) => (
		<span className="whitespace-nowrap text-sm text-muted-foreground">
			{relativeTime(row.original.started_at)}
		</span>
	),
	size: 110,
};

const projectColumn: ColumnDef<SessionListItem> = {
	id: "project",
	accessorFn: (s) => s.project_path ?? "",
	header: "Project",
	cell: ({ row }) => (
		<div
			className="truncate text-sm text-muted-foreground"
			title={row.original.project_path ?? undefined}
		>
			{row.original.project_path?.split("/").pop() ?? "—"}
		</div>
	),
	size: 160,
};

const messagesColumn: ColumnDef<SessionListItem> = {
	id: "messages",
	accessorFn: (s) => s.message_count,
	header: () => <span className="block text-right">Messages</span>,
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
	header: () => <span className="block text-right">Tokens</span>,
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
	{ ...agentColumn, size: 200 },
	projectColumn,
	messagesColumn,
	tokensColumn,
	startedColumn,
];

// Compact 3-col layout for the Overview "Recent sessions" widget. Sum of
// widths (~710) fits the half-width dashboard column without overflow.
export const sessionColumnsCompact: ColumnDef<SessionListItem>[] = [
	summaryColumn,
	agentColumn,
	startedColumn,
];
