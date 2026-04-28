import { MessageSquare, Zap } from "lucide-react";
import Link from "next/link";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { ModelBadge } from "@/components/meta/model-badge";
import { Stat } from "@/components/meta/stat";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatNumber, formatSessionSummary, relativeTime } from "@/lib/utils";

export function SessionRow({ session }: { session: SessionListItem }) {
	const s = session;
	const totalTokens = s.input_tokens + s.output_tokens;
	return (
		<Link
			href={`/sessions/${s.id}`}
			className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent/40"
		>
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium">
					{formatSessionSummary(s.summary) || s.local_session_id.slice(0, 8)}
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
					{s.agent_type ? (
						<Badge variant="outline" className="h-5">
							{agentTypeLabel(s.agent_type)}
						</Badge>
					) : null}
					<span className="truncate text-xs text-muted-foreground">
						{s.project_path?.split("/").pop() ?? "no project"}
					</span>
					<ModelBadge modelId={s.model} />
					<Stat icon={MessageSquare} label={String(s.message_count)} />
					<Stat icon={Zap} label={`${formatNumber(totalTokens)} tokens`} />
				</div>
			</div>
			<span
				className="shrink-0 text-xs text-muted-foreground"
				title={`Started ${relativeTime(s.started_at)}`}
			>
				{relativeTime(s.updated_at)}
			</span>
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
