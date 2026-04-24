"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { AgentLabel } from "@/components/dashboard/agent-label";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatSessionSummary, relativeTime } from "@/lib/utils";

// Single column definition used by /sessions AND the Overview "Recent
// sessions" widget. Plain-label headers (no sort chevrons) — server
// returns `started_at DESC`. Uniform columns avoid the dashboard
// splitting into two visual languages.
//
// The "Agent" column pairs agent type with machine name (e.g.
// "Claude Code · kingsley-mbp") — an agent without its host is useless
// context for a multi-machine user.
export const sessionColumns: ColumnDef<SessionListItem>[] = [
	{
		id: "summary",
		accessorKey: "summary",
		header: "Summary",
		cell: ({ row }) => {
			const s = row.original;
			const title = formatSessionSummary(s.summary) || s.local_session_id.slice(0, 8);
			return (
				<Link
					href={`/sessions/${s.id}`}
					onClick={(e) => e.stopPropagation()}
					className="truncate font-medium hover:underline"
				>
					{title}
				</Link>
			);
		},
		size: 420,
	},
	{
		id: "agent",
		accessorFn: (s) => `${s.machine_name ?? ""} ${s.agent_type ?? ""}`,
		header: "Agent",
		cell: ({ row }) => (
			<AgentLabel
				machineName={row.original.machine_name}
				type={row.original.agent_type}
				size="sm"
			/>
		),
		size: 200,
	},
	{
		id: "project",
		accessorFn: (s) => s.project_path ?? "",
		header: "Project",
		cell: ({ row }) => (
			<span
				className="truncate text-sm text-muted-foreground"
				title={row.original.project_path ?? undefined}
			>
				{row.original.project_path?.split("/").pop() ?? "—"}
			</span>
		),
		size: 160,
	},
	{
		id: "messages",
		accessorFn: (s) => s.message_count,
		header: () => <span className="block text-right">Messages</span>,
		cell: ({ row }) => (
			<span className="block text-right text-sm tabular-nums text-muted-foreground">
				{row.original.message_count}
			</span>
		),
		size: 90,
	},
	{
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
	},
	{
		id: "started_at",
		accessorKey: "started_at",
		header: "Started",
		cell: ({ row }) => (
			<span className="whitespace-nowrap text-sm text-muted-foreground">
				{relativeTime(row.original.started_at)}
			</span>
		),
		size: 110,
	},
];
