"use client";

import { AlertCircle, ArrowUpRight, Cloud } from "lucide-react";
import Link from "next/link";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/utils";

// Freshness threshold — "active" means the agent pinged us in the last 5 minutes.
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export function isAgentActive(lastSeenAt: string | null | undefined): boolean {
	if (!lastSeenAt) return false;
	return Date.now() - new Date(lastSeenAt).getTime() < ACTIVE_WINDOW_MS;
}

/**
 * UI-side projection of an agent for the dashboard grid. The dashboard
 * page composes this from cloud-api environments and (for hosted users)
 * clawdi.ai deployments — `AgentsCard` itself stays generic and
 * never imports cross-origin clients or `@/hosted/*`.
 */
export interface AgentTile {
	id: string;
	source: "self-managed" | "on-clawdi";
	name: string;
	agentType: string | null;
	/** "OpenClaw · Daemon", "Codex · CLI", etc. */
	runtimeLabel: string;
	/** "Synced 2m ago", "Running", "Provisioning…" — already humanized. */
	statusLabel: string;
	/** Used to compute the "N active now" count in the card description. */
	lastSeenAt?: string | null;
	/** Click target. Internal route for self-managed, external for hosted. */
	href: string;
	external?: boolean;
	/** Counted in the "N active now" header line; no per-tile indicator rendered. */
	active?: boolean;
}

export function AgentsCard({
	agents,
	isLoading,
	hostedStatus,
}: {
	agents: AgentTile[];
	isLoading: boolean;
	/**
	 * Optional secondary loading/error slice for hosted deployments.
	 * Lets the card show "fetching hosted agents" or surface a network
	 * problem inline without blocking the self-managed list.
	 */
	hostedStatus?: { isLoading: boolean; error?: Error | null };
}) {
	const activeCount = agents.filter((a) => a.active).length;
	const total = agents.length;
	const mostRecent = agents
		.map((a) => a.lastSeenAt)
		.filter((t): t is string => Boolean(t))
		.sort((a, b) => b.localeCompare(a))[0];

	let description: string;
	if (total === 0 && !hostedStatus?.isLoading) {
		description = "Run `clawdi auth login` on a machine, or deploy on Clawdi.";
	} else if (activeCount > 0) {
		description = `${activeCount} active now · ${total} total`;
	} else if (mostRecent) {
		description = `${total} agents · last sync ${relativeTime(mostRecent)}`;
	} else if (total > 0) {
		description = `${total} agents`;
	} else {
		description = "Loading hosted agents…";
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Agents</CardTitle>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{isLoading ? (
					<div className="grid gap-2 sm:grid-cols-2">
						{Array.from({ length: 4 }).map((_, i) => (
							<TileSkeleton key={i} />
						))}
					</div>
				) : agents.length || hostedStatus?.isLoading ? (
					<div className="grid gap-2 sm:grid-cols-2">
						{agents.map((tile) => (
							<AgentTileView key={`${tile.source}:${tile.id}`} tile={tile} />
						))}
						{hostedStatus?.isLoading ? <TileSkeleton /> : null}
					</div>
				) : hostedStatus?.error ? null : (
					// When the hosted fetch failed, the error banner below carries
					// the message — render no empty state to avoid contradicting it.
					<EmptyState
						fillHeight={false}
						description="No agents yet. Run `clawdi auth login` to register a machine, or deploy on Clawdi."
					/>
				)}
				{hostedStatus?.error ? (
					<div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
						<AlertCircle className="size-3.5 text-destructive" />
						<span>Hosted agents unavailable. Self-managed agents listed above.</span>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

function AgentTileView({ tile }: { tile: AgentTile }) {
	const onClawdi = tile.source === "on-clawdi";

	const body = (
		<>
			<AgentIcon agent={tile.agentType ?? "openclaw"} />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate font-medium">{tile.name}</span>
					{onClawdi ? (
						<span
							className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
							title="Hosted on Clawdi"
						>
							<Cloud className="size-2.5" />
							Clawdi
						</span>
					) : null}
				</div>
				<div className="flex items-center gap-1 text-xs text-muted-foreground">
					<span className="truncate">{tile.runtimeLabel}</span>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
				<span>{tile.statusLabel}</span>
				{tile.external ? <ArrowUpRight className="size-3.5" /> : null}
			</div>
		</>
	);

	const className =
		"flex items-center gap-3 rounded-md border p-3 transition-colors hover:bg-accent/40";

	if (tile.external) {
		return (
			<a href={tile.href} target="_blank" rel="noopener noreferrer" className={className}>
				{body}
			</a>
		);
	}
	return (
		<Link href={tile.href} className={className}>
			{body}
		</Link>
	);
}

function TileSkeleton() {
	return (
		<div className="flex items-center gap-3 rounded-md border p-3">
			<Skeleton className="size-8 rounded-md" />
			<div className="flex-1 space-y-1.5">
				<Skeleton className="h-4 w-24" />
				<Skeleton className="h-3 w-32" />
			</div>
		</div>
	);
}
