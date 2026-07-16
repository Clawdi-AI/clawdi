"use client";

import type { components } from "@clawdi/shared/api";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type ApiErrorNormalizer, ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import {
	AgentSourceBadge,
	agentDisplayName,
	agentIdentity,
	compareAgentEnvironments,
	displayMachineName,
	LegacyAgentBadge,
} from "@/components/dashboard/agent-label";
import { daemonStatusVisual } from "@/components/dashboard/daemon-status";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_CARD_BUTTON_FOCUS_CLASS,
	ENTITY_GRID_CLASS,
	EntityHeader,
} from "@/components/entity-card";
import { Skeleton } from "@/components/ui/skeleton";
import { agentSectionHref } from "@/lib/agent-routes";
import { cn, relativeTime } from "@/lib/utils";

type Env = components["schemas"]["AgentResponse"];

// Freshness threshold — "active" means the agent pinged us in the last 5 minutes.
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export function isAgentActive(lastSeenAt: string | null | undefined): boolean {
	if (!lastSeenAt) return false;
	return Date.now() - new Date(lastSeenAt).getTime() < ACTIVE_WINDOW_MS;
}

/**
 * Build self-managed AgentTiles from cloud-api environments. Shared by the
 * Overview grid and the `/agents` index so the tile shape stays identical
 * across both surfaces (single source of truth for the connected-agent row).
 */
export function selfManagedAgentTiles(environments: Env[] | undefined): AgentTile[] {
	return (environments ?? []).map((env) => ({
		id: env.id,
		source: "self-managed" as const,
		name: agentDisplayName(env),
		avatarUrl: env.avatar_url,
		sortOrder: env.sort_order,
		agentType: env.agent_type,
		statusLabel: env.last_seen_at ? `Active ${relativeTime(env.last_seen_at)}` : "Never seen",
		lastSeenAt: env.last_seen_at,
		href: agentSectionHref(env.id),
		active: isAgentActive(env.last_seen_at),
		env,
	}));
}

export interface AgentTileStatusDot {
	label: string;
	dotClass: string;
}

export interface AgentTileSecondaryStatus {
	label: string;
	title?: string;
	textClass?: string;
}

/**
 * UI-side projection of an agent for the dashboard grid. The dashboard
 * page composes this from cloud-api environments and (for hosted users)
 * hosted deployments — `AgentsCard` itself stays generic and
 * never imports cross-origin clients or `@/hosted/*`.
 */
export interface AgentTile {
	id: string;
	source: "self-managed" | "on-clawdi" | "legacy-hosted";
	name: string;
	avatarUrl?: string | null;
	sortOrder?: number | null;
	agentType: string | null;
	/** Optional deployment/source context for callers that group or label hosted tiles. */
	contextLabel?: string | null;
	/** Humanized fallback when there is no last-seen timestamp ("Running", "Never seen"). */
	statusLabel: string;
	/** Used to compute the "N active now" count in the card description. */
	lastSeenAt?: string | null;
	/** Primary click target. Points at the in-app env detail page
	 * (`/agents/{env_id}`). Hosted tiles derive this identity from deployment
	 * config even while the cloud-api projection is absent. A hosted deployment
	 * with no minted env id remains non-navigable. */
	href: string | null;
	external?: boolean;
	/** Optional card-level action supplied by the owning integration. */
	action?: ReactNode;
	/** Optional hosted remediation target retained for surfaces that open
	 * status dialogs. Tiles render daemon status as a non-interactive dot. */
	manageHref?: string;
	/** Counted in the "N active now" header line; no per-tile indicator rendered. */
	active: boolean;
	/** Primary status dot. Hosted tiles use compute status here; connected tiles
	 * omit it and fall back to live-sync status. */
	statusDot?: AgentTileStatusDot;
	/** Secondary qualifier appended to the tile meta line. Hosted tiles use this
	 * only for meaningful sync qualifiers such as "Sync paused". */
	secondaryStatus?: AgentTileSecondaryStatus | null;
	/** Self-managed envs carry the full EnvironmentResponse so the
	 * tile can render a sync indicator. Hosted tiles join their
	 * cloud-api env via `clawdi_cloud_environments` and end up with
	 * the same shape; hosted deployments without a registered env leave
	 * this null. */
	env?: Env | null;
}

export interface AgentFleetSummary {
	activeCount: number;
	total: number;
	lastActive: string | null;
}

export function fleetSummaryFromTiles(agents: readonly AgentTile[]): AgentFleetSummary {
	return {
		activeCount: agents.filter((agent) => agent.active).length,
		total: agents.length,
		lastActive:
			agents
				.map((agent) => agent.lastSeenAt)
				.filter((value): value is string => Boolean(value))
				.sort((a, b) => b.localeCompare(a))[0] ?? null,
	};
}

export function AgentsCard({
	agents,
	isLoading,
	error,
	onRetry,
	hostedStatus,
}: {
	agents: AgentTile[];
	isLoading: boolean;
	error?: unknown;
	onRetry?: () => void;
	/**
	 * Optional secondary loading/error slice for hosted deployments.
	 * Lets the card show "fetching hosted agents" or surface a network
	 * problem inline without blocking the self-managed list.
	 */
	hostedStatus?: {
		isLoading: boolean;
		error?: unknown;
		onRetry?: () => void;
		normalizer?: ApiErrorNormalizer;
	};
}) {
	const [showAll, setShowAll] = useState(false);
	const total = agents.length;
	const ordered = [...agents].sort(compareAgentTiles);
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
				{error ? (
					<ApiErrorPanel error={error} onRetry={onRetry} title="Couldn't load agents" />
				) : isLoading ? (
					<div className={ENTITY_GRID_CLASS}>
						{Array.from({ length: 4 }).map((_, i) => (
							<TileSkeleton key={i} />
						))}
					</div>
				) : agents.length || hostedStatus?.isLoading ? (
					<>
						<div className={ENTITY_GRID_CLASS}>
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
						variant="inset"
						title="No agents yet"
						description="Connect an agent to see it here."
					/>
				)}
				{hostedStatus?.error ? (
					<HostedUnavailableBanner
						error={hostedStatus.error}
						onRetry={hostedStatus.onRetry}
						normalizer={hostedStatus.normalizer}
					/>
				) : null}
			</div>
		</section>
	);
}

/**
 * One canonical banner for "the hosted-deployments fetch failed but the rest
 * of the page is fine." Used by both AgentsCard (Overview) and the grouped
 * /agents view so the copy + chrome match. Self-managed and connected agents
 * are the same thing here, so the copy stays neutral.
 */
export function HostedUnavailableBanner({
	error,
	onRetry,
	normalizer,
}: {
	error: unknown;
	onRetry?: () => void;
	normalizer?: ApiErrorNormalizer;
}) {
	return (
		<ApiErrorPanel
			error={error}
			onRetry={onRetry}
			normalizer={normalizer}
			title="Couldn't load Clawdi Cloud agents"
		/>
	);
}

/** Bare responsive grid of agent tiles — no card chrome, cap, or empty state.
 * Used by grouped surfaces (e.g. the /agents index grouped by compute) that
 * supply their own section headers. */
export function AgentTileGrid({ tiles }: { tiles: AgentTile[] }) {
	return (
		<div className={ENTITY_GRID_CLASS}>
			{tiles.map((tile) => (
				<AgentTileView key={`${tile.source}:${tile.id}`} tile={tile} />
			))}
		</div>
	);
}

function AgentTileView({ tile }: { tile: AgentTile }) {
	const onClawdi = tile.source === "on-clawdi";
	const legacyHosted = tile.source === "legacy-hosted";
	// Source pill is an identity adornment, not metadata — it sits
	// next to the title so it stays glued to the agent name no matter
	// how the meta wraps. Status is a separate leading dot so the title
	// and meta keep their width in the narrow overview grid.
	const source = onClawdi ? "hosted" : "connected";
	const sourcePill = onClawdi ? (
		<AgentSourceBadge source={source} iconOnly />
	) : legacyHosted ? (
		<LegacyAgentBadge iconOnly />
	) : null;
	const identity = agentIdentity({
		name: tile.name,
		machine_name: tile.name,
		agent_type: tile.agentType,
	});
	const meta: string[] = [];
	if (tile.contextLabel) meta.push(tile.contextLabel);
	if (identity.secondaryLabel) meta.push(identity.secondaryLabel);
	if (onClawdi) meta.push(tile.statusLabel);
	const activityLabel = agentTileActivityLabel(tile);
	if (activityLabel && !onClawdi) meta.push(activityLabel);
	const statusVisual = daemonStatusVisual(
		tile.env,
		onClawdi || legacyHosted ? "on-clawdi" : "self-managed",
	);
	const statusDot = tile.statusDot ?? {
		label: statusVisual.label,
		dotClass: statusVisual.dotClass,
	};

	const card = (
		<div
			className={cn(ENTITY_CARD_BASE, "relative h-full transition-colors group-hover:bg-muted/50")}
		>
			<EntityHeader
				align="start"
				icon={<AgentIcon agent={tile.agentType} size="lg" avatarUrl={tile.avatarUrl} />}
				title={
					<span className="flex min-w-0 items-center gap-1.5">
						<AgentStatusDot visual={statusDot} />
						<span className="min-w-0 truncate" title={tile.name}>
							{displayMachineName(tile.name)}
						</span>
					</span>
				}
				meta={meta.length > 0 ? meta : undefined}
				titleAdornment={sourcePill}
				className={cn("min-w-0 flex-1", tile.action && "pr-8")}
			/>
			{onClawdi && tile.secondaryStatus ? (
				<div
					className={cn(
						"mt-0.5 pl-11 text-xs leading-4",
						tile.secondaryStatus.textClass ?? "text-muted-foreground",
					)}
					title={tile.secondaryStatus.title}
				>
					{tile.secondaryStatus.label}
				</div>
			) : null}
			{tile.external ? (
				<ArrowUpRight
					aria-hidden
					className="pointer-events-none absolute right-3 top-3.5 size-3.5 text-muted-foreground"
				/>
			) : null}
			{tile.action ? <div className="absolute top-2 right-2">{tile.action}</div> : null}
		</div>
	);
	const linkClassName = cn(
		"group block h-full rounded-lg text-inherit no-underline",
		ENTITY_CARD_BUTTON_FOCUS_CLASS,
	);
	const linkStatus = [statusDot.label, tile.secondaryStatus?.label].filter(Boolean).join(", ");
	const linkIdentity = tile.contextLabel ? `${tile.name} (${tile.contextLabel})` : tile.name;
	const linkLabel = `Open ${linkIdentity}. Status: ${linkStatus}`;

	if (!tile.href) {
		return (
			<div className="block h-full rounded-lg text-inherit" title={`Status: ${linkStatus}`}>
				{card}
			</div>
		);
	}

	if (tile.external) {
		return (
			<a
				href={tile.href}
				target="_blank"
				rel="noopener noreferrer"
				className={linkClassName}
				aria-label={linkLabel}
			>
				{card}
			</a>
		);
	}

	return (
		<Link to={tile.href} className={linkClassName} aria-label={linkLabel}>
			{card}
		</Link>
	);
}

function AgentStatusDot({ visual }: { visual: AgentTileStatusDot }) {
	return (
		<span title={visual.label} className="inline-flex shrink-0 items-center">
			<span aria-hidden className={cn("size-1.5 rounded-full", visual.dotClass)} />
			<span className="sr-only">{visual.label}</span>
		</span>
	);
}

function agentTileActivityLabel(tile: AgentTile): string | null {
	if (tile.lastSeenAt) return relativeTime(tile.lastSeenAt);
	return null;
}

export function compareAgentTiles(a: AgentTile, b: AgentTile): number {
	if (a.env && b.env) return compareAgentEnvironments(a.env, b.env);
	const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
	const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
	if (aOrder !== bOrder) return aOrder - bOrder;
	const name = a.name.localeCompare(b.name);
	if (name !== 0) return name;
	return a.id.localeCompare(b.id);
}

function TileSkeleton() {
	return (
		<div className={cn(ENTITY_CARD_BASE, "flex h-full items-start gap-3")}>
			<Skeleton className="size-8 shrink-0 rounded-md" />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<Skeleton className="size-1.5 shrink-0 rounded-full" />
					<Skeleton className="h-4 min-w-16 flex-1 max-w-28" />
					<Skeleton className="ml-0.5 size-4 shrink-0 rounded-full" />
				</div>
				<Skeleton className="mt-1 h-3 w-28 max-w-[80%]" />
			</div>
		</div>
	);
}
