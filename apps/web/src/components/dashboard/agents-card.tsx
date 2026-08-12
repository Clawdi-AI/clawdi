"use client";

import type { components } from "@clawdi/shared/api";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { type ApiErrorNormalizer, ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import {
	AgentSourceBadge,
	agentDisplayName,
	agentIdentity,
	compareAgentEnvironments,
	LegacyAgentBadge,
} from "@/components/dashboard/agent-label";
import { type DaemonStatusVisual, daemonStatusVisual } from "@/components/dashboard/daemon-status";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	ENTITY_STRETCHED_LINK_CLASS,
	EntityCardSkeleton,
	EntityHeader,
} from "@/components/entity-card";
import { agentRouteIdsEqual, agentSectionHref, parseAgentPathname } from "@/lib/agent-routes";
import { cn, relativeTime } from "@/lib/utils";

type Env = components["schemas"]["AgentResponse"];

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
		href: agentSectionHref(env.id),
		env,
	}));
}

export type AgentCardStatusVisual = Pick<DaemonStatusVisual, "label" | "tooltip" | "dotClass">;

export interface AgentCardStatusProjection {
	visual: AgentCardStatusVisual;
	/** Explicit status labels rendered in the compact card metadata. */
	labels: string[];
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
	/** Primary click target. Points at the in-app env detail page
	 * (`/agents/{env_id}`). Hosted tiles derive this identity from deployment
	 * config even while the cloud-api projection is absent. A hosted deployment
	 * with no minted env id remains non-navigable. */
	href: string | null;
	external?: boolean;
	/** Optional remediation target for legacy status dialogs. */
	manageHref?: string;
	/** Hosted integrations can project compute-first status without making the
	 * generic card import hosted lifecycle types. */
	cardStatus?: AgentCardStatusProjection;
	/** Whether this hosted deployment has an authoritative Files endpoint. */
	filesAvailable?: boolean;
	/** Self-managed envs carry the full EnvironmentResponse so the
	 * tile can render a sync indicator. Hosted tiles join their
	 * cloud-api env via `clawdi_cloud_environments` and end up with
	 * the same shape; hosted deployments without a registered env leave
	 * this null. */
	env?: Env | null;
}

export function agentTileMatchesRouteId(
	tile: AgentTile,
	routeId: string,
	deploymentSelector?: string | null,
): boolean {
	if (deploymentSelector) {
		return tile.source === "on-clawdi" && agentRouteIdsEqual(tile.id, deploymentSelector);
	}
	if (agentRouteIdsEqual(tile.id, routeId) || agentRouteIdsEqual(tile.env?.id, routeId))
		return true;
	return tile.href ? agentRouteIdsEqual(parseAgentPathname(tile.href)?.agentId, routeId) : false;
}

export interface AgentFleetSummary {
	total: number;
}

export function fleetSummaryFromTiles(agents: readonly AgentTile[]): AgentFleetSummary {
	return { total: agents.length };
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
	// fleet summary ("N agents"), and a bare
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
							<EntityCardSkeleton key={i} iconSize="sm" statusDot titleBadge />
						))}
					</div>
				) : agents.length || hostedStatus?.isLoading ? (
					<>
						<div className={ENTITY_GRID_CLASS}>
							{visible.map((tile) => (
								<AgentTileView key={`${tile.source}:${tile.id}`} tile={tile} />
							))}
							{hostedStatus?.isLoading ? (
								<EntityCardSkeleton iconSize="sm" statusDot titleBadge />
							) : null}
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
			title="Clawdi Cloud inventory unavailable"
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
	const { meta, statusVisual } = agentTileCardProjection(tile);
	const linkLabel = statusVisual
		? `Open ${tile.name}. Status: ${statusVisual.label}`
		: `Open ${tile.name}`;

	return (
		<div
			className={cn(
				ENTITY_CARD_BASE,
				"group relative z-0 h-full p-3 transition-colors hover:bg-muted/50",
			)}
			title={tile.href ? undefined : tile.name}
		>
			<EntityHeader
				icon={<AgentIcon agent={tile.agentType} size="lg" avatarUrl={tile.avatarUrl} />}
				title={
					<span className="flex min-w-0 items-center gap-1.5">
						{statusVisual ? <AgentStatusDot visual={statusVisual} /> : null}
						<span className="min-w-0 truncate" title={tile.name}>
							{tile.name}
						</span>
					</span>
				}
				meta={meta.length > 0 ? meta : undefined}
				titleAdornment={sourcePill}
				className="min-w-0 flex-1"
			/>
			{tile.external ? (
				<ArrowUpRight
					aria-hidden
					className="pointer-events-none absolute right-3 top-3.5 size-3.5 text-muted-foreground"
				/>
			) : null}
			{tile.href ? (
				tile.external ? (
					<a
						href={tile.href}
						target="_blank"
						rel="noopener noreferrer"
						className={ENTITY_STRETCHED_LINK_CLASS}
						aria-label={linkLabel}
					>
						<span className="sr-only">{linkLabel}</span>
					</a>
				) : (
					<Link to={tile.href} className={ENTITY_STRETCHED_LINK_CLASS} aria-label={linkLabel}>
						<span className="sr-only">{linkLabel}</span>
					</Link>
				)
			) : null}
		</div>
	);
}

function AgentStatusDot({ visual }: { visual: AgentCardStatusVisual }) {
	return (
		<span
			title={`Status: ${visual.label}. ${visual.tooltip}`}
			className="inline-flex shrink-0 items-center"
		>
			<span aria-hidden className={cn("size-1.5 rounded-full", visual.dotClass)} />
			<span className="sr-only">{visual.label}</span>
		</span>
	);
}

/**
 * The compact card projects sync only from a real Cloud API environment.
 * A v2 deployment can exist before that projection arrives; rendering the
 * daemon's null-env "pending" state there would turn missing data into a
 * reassuring status. Self-managed and legacy tiles retain their established
 * setup status because their environment record is their source of truth.
 * Metadata is intentionally limited to the highest-priority available label.
 */
export function agentTileCardProjection(tile: AgentTile): {
	meta: [] | [string];
	statusVisual: AgentCardStatusVisual | null;
} {
	const identity = agentIdentity({
		name: tile.name,
		machine_name: tile.name,
		agent_type: tile.agentType,
	});
	const metaLabel =
		tile.cardStatus?.labels[0] ?? agentTileActivityLabel(tile) ?? identity.secondaryLabel;
	const statusVisual = tile.cardStatus
		? tile.cardStatus.visual
		: tile.source === "on-clawdi" && !tile.env
			? null
			: daemonStatusVisual(tile.env, tile.source === "self-managed" ? "self-managed" : "on-clawdi");
	return { meta: metaLabel ? [metaLabel] : [], statusVisual };
}

function agentTileActivityLabel(tile: AgentTile): string | null {
	if (tile.env?.last_sync_at) return `Synced ${relativeTime(tile.env.last_sync_at)}`;
	if (tile.env?.last_seen_at) return `Seen ${relativeTime(tile.env.last_seen_at)}`;
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
