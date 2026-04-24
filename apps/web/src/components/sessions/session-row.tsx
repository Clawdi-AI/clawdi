import { MessageSquare, Zap } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatSessionSummary, relativeTime } from "@/lib/utils";

function agentLabel(agent: string | null | undefined): string {
	if (agent === "claude_code") return "Claude Code";
	if (agent === "hermes") return "Hermes";
	return agent ?? "";
}

export function SessionRow({ session }: { session: SessionListItem }) {
	const s = session;
	return (
		<Link
			href={`/sessions/${s.id}`}
			className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent/40"
		>
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium">
					{formatSessionSummary(s.summary) || s.local_session_id.slice(0, 8)}
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					{s.agent_type ? <Badge variant="outline">{agentLabel(s.agent_type)}</Badge> : null}
					<span className="truncate">{s.project_path?.split("/").pop() ?? "no project"}</span>
					{s.model ? <span className="truncate">{s.model.replace("claude-", "")}</span> : null}
					<span className="flex items-center gap-1">
						<MessageSquare className="size-3" />
						{s.message_count}
					</span>
					<span className="flex items-center gap-1">
						<Zap className="size-3" />
						{((s.input_tokens + s.output_tokens) / 1000).toFixed(1)}k
					</span>
				</div>
			</div>
			<span className="shrink-0 text-xs text-muted-foreground">{relativeTime(s.started_at)}</span>
		</Link>
	);
}

export function SessionRowSkeleton() {
	return (
		<div className="flex items-center justify-between gap-4 px-4 py-3">
			<div className="min-w-0 flex-1 space-y-2">
				<Skeleton className="h-4 w-64" />
				<Skeleton className="h-4 w-48" />
			</div>
			<Skeleton className="h-4 w-16" />
		</div>
	);
}
