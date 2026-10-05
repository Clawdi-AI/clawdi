"use client";
import { agentsCardClasses } from "@clawdi/shared/ui";
import {
	type AgentCardStatusVisual,
	type AgentTile,
	agentSurfaceCopy,
	agentTileCardProjection,
	compareAgentTiles,
} from "@clawdi/shared/view";

import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { type ApiErrorNormalizer, ApiErrorPanel } from "@/components/api-error-panel";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentSourceBadge, LegacyAgentBadge } from "@/components/dashboard/agent-label";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	ENTITY_STRETCHED_LINK_CLASS,
	EntityCardSkeleton,
	EntityHeader,
} from "@/components/entity-card";
import { preloadHostedAgentHome } from "@/lib/agent-home-loader";
import { agentRouteIdsEqual, parseAgentPathname } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";

export function agentTileMatchesRouteId(tile: AgentTile, routeId: string): boolean {
	if (agentRouteIdsEqual(tile.id, routeId) || agentRouteIdsEqual(tile.env?.id, routeId))
		return true;
	return tile.href ? agentRouteIdsEqual(parseAgentPathname(tile.href)?.agentId, routeId) : false;
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
	const ordered = [...agents].sort(compareAgentTiles);

	// Tiles start flush with the column, level with the cards on the right.
	return (
		<section className={agentsCardClasses.spaceY}>
			<div className={agentsCardClasses.spaceY}>
				{error ? (
					<ApiErrorPanel
						error={error}
						onRetry={onRetry}
						title={agentSurfaceCopy.couldnTLoadAgents}
					/>
				) : isLoading ? (
					<div className={ENTITY_GRID_CLASS}>
						{Array.from({ length: 4 }).map((_, i) => (
							<EntityCardSkeleton key={i} iconSize="sm" statusDot titleBadge />
						))}
					</div>
				) : agents.length || hostedStatus?.isLoading ? (
					<div className={ENTITY_GRID_CLASS}>
						{ordered.map((tile) => (
							<AgentTileView key={`${tile.source}:${tile.id}`} tile={tile} />
						))}
						{hostedStatus?.isLoading ? (
							<EntityCardSkeleton iconSize="sm" statusDot titleBadge />
						) : null}
					</div>
				) : hostedStatus?.error ? null : (
					// When the hosted fetch failed, the error banner below carries
					// the message — render no empty state to avoid contradicting it.
					<EmptyState
						variant="inset"
						title={agentSurfaceCopy.noAgentsYet}
						description={agentSurfaceCopy.connectAnAgentToSeeItHere}
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
			className={cn(ENTITY_CARD_BASE, agentsCardClasses.tile)}
			title={tile.href ? undefined : tile.name}
		>
			<EntityHeader
				icon={<AgentIcon agent={tile.agentType} size="lg" avatarUrl={tile.avatarUrl} />}
				title={
					<span className={agentsCardClasses.flexMinWItems}>
						{statusVisual ? <AgentStatusDot visual={statusVisual} /> : null}
						<span className={agentsCardClasses.minWTruncate} title={tile.name}>
							{tile.name}
						</span>
					</span>
				}
				meta={meta.length > 0 ? meta : undefined}
				titleAdornment={sourcePill}
				className={agentsCardClasses.minWFlex}
			/>
			{tile.external ? (
				<ArrowUpRight aria-hidden className={agentsCardClasses.pointerEventsNoneAbsolute} />
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
						<span className={agentsCardClasses.srOnly}>{linkLabel}</span>
					</a>
				) : (
					<Link
						to={tile.href}
						className={ENTITY_STRETCHED_LINK_CLASS}
						aria-label={linkLabel}
						onMouseEnter={preloadHostedAgentHome}
						onFocus={preloadHostedAgentHome}
						onTouchStartCapture={preloadHostedAgentHome}
					>
						<span className={agentsCardClasses.srOnly}>{linkLabel}</span>
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
			className={agentsCardClasses.inlineFlexShrinkItems}
		>
			<span aria-hidden className={cn(agentsCardClasses.dot, visual.dotClass)} />
			<span className={agentsCardClasses.srOnly}>{visual.label}</span>
		</span>
	);
}
