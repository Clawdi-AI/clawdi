"use client";

import { Laptop, Plus } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Environment } from "@/lib/api-schemas";
import { relativeTime } from "@/lib/utils";

// Freshness threshold — "active" means the agent pinged us in the last 5 minutes.
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

function agentLabel(agent: string | null | undefined): string {
	if (agent === "claude_code") return "Claude Code";
	if (agent === "codex") return "Codex";
	if (agent === "hermes") return "Hermes";
	if (agent === "openclaw") return "OpenClaw";
	return agent ?? "Agent";
}

function isActive(lastSeenAt: string | null | undefined): boolean {
	if (!lastSeenAt) return false;
	return Date.now() - new Date(lastSeenAt).getTime() < ACTIVE_WINDOW_MS;
}

export function AgentsCard({
	environments,
	isLoading,
}: {
	environments: Environment[] | undefined;
	isLoading: boolean;
}) {
	const activeCount = environments?.filter((e) => isActive(e.last_seen_at)).length ?? 0;
	const total = environments?.length ?? 0;
	const mostRecent = environments
		?.map((e) => e.last_seen_at)
		.filter((t): t is string => Boolean(t))
		.sort((a, b) => b.localeCompare(a))[0];

	let description: string;
	if (total === 0) {
		description = "Run `clawdi login` on a machine to register your first agent.";
	} else if (activeCount > 0) {
		description = `${activeCount} active now · ${total} total`;
	} else if (mostRecent) {
		description = `${total} agents · last sync ${relativeTime(mostRecent)}`;
	} else {
		description = `${total} agents`;
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Agents</CardTitle>
				<CardDescription>{description}</CardDescription>
				<CardAction>
					<Button asChild variant="outline" size="sm">
						<a href="#add-agent">
							<Plus />
							Add
						</a>
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent>
				{isLoading ? (
					<div className="grid gap-2 sm:grid-cols-2">
						{Array.from({ length: 4 }).map((_, i) => (
							<div key={i} className="flex items-center gap-3 rounded-md border p-3">
								<Skeleton className="size-8 rounded-md" />
								<div className="flex-1 space-y-1.5">
									<Skeleton className="h-4 w-24" />
									<Skeleton className="h-3 w-32" />
								</div>
							</div>
						))}
					</div>
				) : environments?.length ? (
					<div className="grid gap-2 sm:grid-cols-2">
						{environments.map((env) => (
							<AgentTile key={env.id} env={env} />
						))}
					</div>
				) : (
					<EmptyState description="No agents registered yet. Use the Add an agent panel below to connect your first machine." />
				)}
			</CardContent>
		</Card>
	);
}

function AgentTile({ env }: { env: Environment }) {
	const active = isActive(env.last_seen_at);
	return (
		<div className="flex items-center gap-3 rounded-md border p-3">
			<div className="relative flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
				<Laptop className="size-4 text-muted-foreground" />
				{active ? (
					<span
						className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card"
						aria-hidden
					/>
				) : null}
			</div>
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium">{env.machine_name}</div>
				<div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
					<Badge variant="outline">{agentLabel(env.agent_type)}</Badge>
					<span className="truncate">
						{env.last_seen_at ? relativeTime(env.last_seen_at) : "never seen"}
					</span>
				</div>
			</div>
		</div>
	);
}
