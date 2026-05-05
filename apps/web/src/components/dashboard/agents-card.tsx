"use client";

import type { components } from "@clawdi/shared/api";
import { AlertCircle, ArrowUpRight, Cloud } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { DaemonStatusBadge } from "@/components/dashboard/daemon-status";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/utils";

type Env = components["schemas"]["EnvironmentResponse"];

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
	/** "OpenClaw", "Claude Code", etc. — agent name only, no jargon suffix. */
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
	/** Self-managed envs carry the full EnvironmentResponse so the
	 * tile can render a sync indicator. Hosted-on-Clawdi tiles
	 * leave this null — they don't have a daemon (yet). */
	env?: Env | null;
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
		description = "Connect your first AI to start syncing across all your agents.";
	} else if (activeCount > 0) {
		description = `${activeCount} active now · ${total} total`;
	} else if (mostRecent) {
		description = `${total} agents · last active ${relativeTime(mostRecent)}`;
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
						description="No AI connected yet. The card on the right walks you through it."
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
	// "Clawdi" pill is an identity adornment, not metadata — it sits
	// next to the title so it stays glued to the agent name no matter
	// how the meta wraps. Hosted agents get the same live-sync badge
	// as self-managed ones; the platform will wire up sync automatically
	// in a future release, so the surface stays consistent today and
	// the data reflects reality once that lands.
	const clawdiPill = onClawdi ? (
		<span
			title="Hosted on Clawdi"
			className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
		>
			<Cloud className="size-2.5" />
			Clawdi
		</span>
	) : null;
	// `tile.env` adds a sync badge that renders a `<button>`
	// (clicks open a status dialog). It MUST live in the meta
	// line under the agent name — same row as `statusLabel` so
	// the user sees one tidy "agent + state" stack per tile.
	// But putting that button as a descendant of a wrapping
	// <Link>/<a> is invalid HTML (nested interactive), trips a
	// React hydration warning, and on some browsers swallows the
	// dialog click entirely.
	//
	// Stretched-link pattern fixes both: the link sits as an
	// absolute overlay (`inset-0`) covering the whole tile but
	// is NOT an ancestor of the meta. The badge wrapper has
	// `relative z-10` so it stacks above the absolute link and
	// captures its own clicks; clicks anywhere else hit the
	// link and navigate. Visual layout matches the original
	// "sync state under the agent name" — pre-fix-attempt the
	// badge was floated to the trailing edge.
	const meta: ReactNode[] = [];
	// Hosted (on-clawdi) tiles use `runtimeLabel` to carry the
	// deployment slug — without it two OpenClaw / Hermes pods
	// linking to different deploy URLs would render
	// indistinguishably ('OpenClaw · Running' on both). Self-
	// managed tiles already convey the runtime via the
	// AgentLabel `type` prop (the icon badge), so adding
	// runtimeLabel there would just duplicate the agent type.
	if (onClawdi && tile.runtimeLabel) meta.push(tile.runtimeLabel);
	if (tile.statusLabel) meta.push(tile.statusLabel);
	if (tile.env) {
		meta.push(
			<span className="relative z-10">
				<DaemonStatusBadge env={tile.env} />
			</span>,
		);
	}

	const card = (
		<Card className="h-full py-0 transition-colors group-hover:bg-accent/40">
			<CardContent className="flex items-center gap-3 p-3">
				<AgentLabel
					machineName={tile.name}
					type={tile.agentType}
					size="lg"
					primary="machine"
					meta={meta}
					titleAdornment={clawdiPill}
					className="min-w-0 flex-1"
				/>
				{tile.external ? (
					<ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
				) : null}
			</CardContent>
		</Card>
	);

	const linkClassName =
		"absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

	return (
		<div className="group relative h-full">
			{card}
			{tile.external ? (
				<a href={tile.href} target="_blank" rel="noopener noreferrer" className={linkClassName}>
					<span className="sr-only">{tile.name}</span>
				</a>
			) : (
				<Link href={tile.href} className={linkClassName}>
					<span className="sr-only">{tile.name}</span>
				</Link>
			)}
		</div>
	);
}

function TileSkeleton() {
	return (
		<Card className="py-0">
			<CardContent className="flex items-center gap-3 p-3">
				<Skeleton className="size-8 shrink-0 rounded-md" />
				<div className="min-w-0 flex-1 space-y-1.5">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-3 w-32" />
				</div>
			</CardContent>
		</Card>
	);
}
