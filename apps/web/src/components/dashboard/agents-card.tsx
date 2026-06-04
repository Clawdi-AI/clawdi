"use client";

import type { components } from "@clawdi/shared/api";
import { AlertCircle, ArrowUpRight, Cloud } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { DaemonStatusBadge } from "@/components/dashboard/daemon-status";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

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
	/** Primary click target. Always points at the in-app env detail
	 * page (`/agents/{env_id}`) when an env is available — for both
	 * self-managed and hosted-with-Phase-4a-env tiles, so the
	 * sessions/skills/memory experience stays unified. Falls back to
	 * the external SaaS dashboard URL only for hosted tiles whose
	 * cloud-api env hasn't been registered yet (pre-Phase-4a legacy
	 * pods, mint-failed deploys). `external` reflects whichever
	 * applies. */
	href: string;
	external?: boolean;
	/** Secondary click target rendered as a small "Manage on Clawdi"
	 * button on hosted tiles only. Goes to the SaaS dashboard for
	 * lifecycle ops (Restart / Stop / Delete) that don't live in the
	 * OSS dashboard. Self-managed tiles leave this undefined.
	 * Stretched-link pattern means this button needs `relative z-10`
	 * so it captures clicks above the inset-0 primary link overlay. */
	manageHref?: string;
	/** Counted in the "N active now" header line; no per-tile indicator rendered. */
	active?: boolean;
	/** Self-managed envs carry the full EnvironmentResponse so the
	 * tile can render a sync indicator. Hosted tiles join their
	 * cloud-api env via `clawdi_cloud_environments` and end up with
	 * the same shape; only legacy hosted pods (no env registered)
	 * leave this null. */
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
	const [showAll, setShowAll] = useState(false);
	const total = agents.length;
	// Active agents first, then most recently seen — and cap the wall at 6
	// so the fleet reads as a glance, not a directory (taste audit #3).
	const ordered = [...agents].sort((a, b) => {
		if (!!a.active !== !!b.active) return a.active ? -1 : 1;
		return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
	});
	const visible = showAll ? ordered : ordered.slice(0, 6);
	const hiddenCount = ordered.length - visible.length;

	// No section header: the greeting directly above already carries the
	// fleet summary ("N agents connected · last active …"), and a bare
	// text header here pushed the tile wall below the right rail's card
	// top — the two columns read as misaligned (Marvin's screenshot).
	// Tiles start flush with the column, level with the cards on the right.
	return (
		<section className="space-y-3">
			<div className="space-y-3">
				{isLoading ? (
					<div className="grid gap-2 sm:grid-cols-2">
						{Array.from({ length: 4 }).map((_, i) => (
							<TileSkeleton key={i} />
						))}
					</div>
				) : agents.length || hostedStatus?.isLoading ? (
					<>
						<div className="grid gap-2 sm:grid-cols-2">
							{visible.map((tile) => (
								<AgentTileView key={`${tile.source}:${tile.id}`} tile={tile} />
							))}
							{hostedStatus?.isLoading ? <TileSkeleton /> : null}
						</div>
						{hiddenCount > 0 || showAll ? (
							<button
								type="button"
								onClick={() => setShowAll((v) => !v)}
								className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
							>
								{showAll ? "Show fewer" : `Show all ${total} agents`}
							</button>
						) : null}
					</>
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
			</div>
		</section>
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
				<DaemonStatusBadge env={tile.env} source={tile.source} manageHref={tile.manageHref} />
			</span>,
		);
	}

	// Trailing-edge slot. Hosted tiles with a `manageHref` get a
	// dedicated "Manage on Clawdi" affordance pointing at the SaaS
	// dashboard's lifecycle UI (Restart/Stop/Delete) — clicked
	// independently of the primary link via `relative z-10`. Hosted
	// fallback tiles (env not yet registered → primary IS the SaaS
	// URL via `external`) get the original ArrowUpRight glyph so the
	// affordance still reads as "this leaves the app".
	const trailing = tile.manageHref ? (
		<a
			href={tile.manageHref}
			target="_blank"
			rel="noopener noreferrer"
			onClick={(e) => e.stopPropagation()}
			title="Manage on Clawdi"
			className="relative z-10 inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/80 px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
		>
			<Cloud className="size-3" />
			Manage
			<ArrowUpRight className="size-2.5" />
		</a>
	) : tile.external ? (
		<ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
	) : null;

	const card = (
		<Card className="h-full py-0 transition-colors group-hover:bg-accent/40">
			<CardContent className="flex items-center gap-3 p-4">
				<AgentLabel
					machineName={tile.name}
					type={tile.agentType}
					size="lg"
					primary="machine"
					meta={meta}
					titleAdornment={clawdiPill}
					className="min-w-0 flex-1"
				/>
				{trailing}
			</CardContent>
		</Card>
	);

	const linkClassName =
		"absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

	return (
		// `z-0` is load-bearing: without an explicit z-index on this
		// `relative` wrapper the browser doesn't create a new stacking
		// context, so the `relative z-10` children inside `card`
		// (DaemonStatusBadge button + the "Manage" trailing link) and
		// the absolute `linkClassName` overlay all compete in the
		// PARENT stacking context. Paint order then depends on DOM
		// sibling order: the overlay link is rendered AFTER the card,
		// so in the parent context it paints on top of the card's
		// interactive children — clicks on the badge / Manage button
		// silently go to the primary link instead. Adding `z-0`
		// promotes this wrapper to its own stacking context, isolating
		// the link overlay (z-auto inside this context) below the
		// `z-10` children. Standard stretched-link defense.
		<div className="group relative z-0 h-full">
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
			<CardContent className="flex items-center gap-3 p-4">
				<Skeleton className="size-8 shrink-0 rounded-md" />
				<div className="min-w-0 flex-1 space-y-1.5">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-3 w-32" />
				</div>
			</CardContent>
		</Card>
	);
}
