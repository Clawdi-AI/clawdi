"use client";

import type { components } from "@clawdi/shared/api";
import { AgentSourceBadge } from "@/components/dashboard/agent-label";
import {
	AgentsCard,
	type AgentTile,
	AgentTileGrid,
	HostedUnavailableBanner,
} from "@/components/dashboard/agents-card";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { useHostedAgentTiles } from "@/hosted/use-hosted-agent-tiles";

type Env = components["schemas"]["EnvironmentResponse"];

/**
 * Hosted-only branch of the dashboard's agent panel.
 *
 * Wraps `useHostedAgentTiles` (cross-origin to the deploy API) and the
 * AgentsCard / OnboardingCard render decision into one component so the
 * entire hosted code path — including the cross-origin client and the
 * empty-state coupling between hosted and self-managed counts — can be
 * loaded via the local dynamic import wrapper.
 *
 * OSS builds never include this file in their main bundle: the
 * dashboard page conditionally constructs the `lazy(() => …)`
 * call only when `IS_HOSTED` is true, so the import path is
 * statically eliminated at build time and the chunk is never
 * generated for self-hosters.
 *
 * Wraps its rendered card in a `<div data-hosted="true">` so the
 * marker actually lives in the runtime DOM (not just the source
 * text), and the OSS-clean static check has something real to
 * verify. A bare wrapper div is fine for layout because the
 * parent's `space-y-4` adds margin between *direct* children — the
 * wrapper IS the direct child, the inner Card / OnboardingCard
 * inherits no extra spacing.
 */
export function HostedAgentsSection({
	selfManagedTiles,
	envsLoading,
	selfManagedCount,
	cloudEnvs,
}: {
	selfManagedTiles: AgentTile[];
	envsLoading: boolean;
	selfManagedCount: number;
	/**
	 * Cloud-api environments the parent already fetched for the
	 * self-managed grid. Passed through so hosted tiles can join
	 * to their daemon-sync row (`config_info.clawdi_cloud_environments`
	 * → `EnvironmentResponse.id`) and render the same status badge
	 * as self-managed tiles. Empty/missing envs is harmless — the
	 * matched-env lookup falls back to null and the tile still renders.
	 */
	cloudEnvs: Env[];
}) {
	const hosted = useHostedAgentTiles({ cloudEnvs });
	// Drop self-managed tiles whose env is already represented by a
	// hosted tile. Without this, a hosted deployment's cloud-api env (created
	// by the admin endpoint) would render twice — once with the
	// "Clawdi" pill and external manage URL, once as a generic
	// self-managed tile.
	// `claimedEnvIds` is lower-cased at insertion in `useHostedAgentTiles`
	// (see comment there); compare on the lower-cased tile id so an
	// uppercase / mixed-case env_id on either side still matches.
	const dedupedSelfManaged = selfManagedTiles.filter(
		(t) => !hosted.claimedEnvIds.has(t.id.toLowerCase()),
	);
	const agentTiles: AgentTile[] = [...hosted.tiles, ...dedupedSelfManaged];
	// Empty state must consider BOTH sources of agents. Hidden behind
	// `!hosted.error` so a transient hosted-fetch failure surfaces in
	// AgentsCard's error banner instead of dropping silently into the
	// onboarding hero.
	const isEmptyState =
		!envsLoading &&
		selfManagedCount === 0 &&
		hosted.tiles.length === 0 &&
		!hosted.isLoading &&
		!hosted.error;
	return (
		<div data-hosted="true">
			{isEmptyState ? (
				<OnboardingCard variant="first-agent" />
			) : (
				<AgentsCard
					agents={agentTiles}
					isLoading={envsLoading}
					hostedStatus={{ isLoading: hosted.isLoading, error: hosted.error }}
				/>
			)}
		</div>
	);
}

/**
 * Right-column "Connect another" CTA — only renders once we know
 * the user has at least one agent (hosted OR self-managed). Shares
 * the hosted deployments query cache with `HostedAgentsSection` via
 * TanStack Query, so it costs no extra network. Without this
 * component the page-level `hasAgents` check would only see
 * self-managed counts and a hosted-only user would never see the
 * secondary CTA.
 */
export function HostedSecondaryCTA({
	selfManagedCount,
	envsLoading,
	cloudEnvs,
}: {
	selfManagedCount: number;
	envsLoading: boolean;
	cloudEnvs: Env[];
}) {
	// Reuses the same hosted deployments TanStack Query cache
	// as `HostedAgentsSection` so passing cloudEnvs here is just
	// re-running the join, not re-fetching.
	const hosted = useHostedAgentTiles({ cloudEnvs });
	// Loading: don't flash an empty slot then pop in. Wait for both
	// sources to settle before deciding whether to show the CTA.
	if (envsLoading || hosted.isLoading) return null;
	const hasAnyAgent = selfManagedCount > 0 || hosted.tiles.length > 0;
	return hasAnyAgent ? <OnboardingCard variant="additional-agent" /> : null;
}

/**
 * The /agents index list: each runtime is a SEPARATE agent, grouped under its
 * shared compute deployment. Hosted runtime-agents are bucketed by `computeId`;
 * self-managed (connected) agents get their own section. Mirrors the per-runtime
 * model the agent-detail page enforces.
 */
export function HostedAgentsByCompute({
	selfManagedTiles,
	envsLoading,
	selfManagedCount,
	cloudEnvs,
}: {
	selfManagedTiles: AgentTile[];
	envsLoading: boolean;
	selfManagedCount: number;
	cloudEnvs: Env[];
}) {
	const hosted = useHostedAgentTiles({ cloudEnvs });
	const dedupedSelfManaged = selfManagedTiles.filter(
		(t) => !hosted.claimedEnvIds.has(t.id.toLowerCase()),
	);

	// Bucket hosted runtime-tiles by their shared compute, preserving order.
	const groups: { key: string; name: string; tiles: AgentTile[] }[] = [];
	const byKey = new Map<string, { key: string; name: string; tiles: AgentTile[] }>();
	for (const tile of hosted.tiles) {
		const key = tile.computeId ?? tile.id;
		let group = byKey.get(key);
		if (!group) {
			group = { key, name: tile.computeName ?? tile.name, tiles: [] };
			byKey.set(key, group);
			groups.push(group);
		}
		group.tiles.push(tile);
	}

	const isEmptyState =
		!envsLoading &&
		selfManagedCount === 0 &&
		hosted.tiles.length === 0 &&
		!hosted.isLoading &&
		!hosted.error;
	if (isEmptyState) {
		return (
			<div data-hosted="true">
				<OnboardingCard variant="first-agent" />
			</div>
		);
	}

	if ((envsLoading || hosted.isLoading) && groups.length === 0 && dedupedSelfManaged.length === 0) {
		return (
			<div data-hosted="true">
				<AgentsCard agents={[]} isLoading />
			</div>
		);
	}

	return (
		<div data-hosted="true" className="space-y-6">
			{groups.map((group) => (
				<section key={group.key} className="space-y-2">
					<div className="flex items-center gap-2 px-0.5">
						<span className="text-sm font-medium">{group.name}</span>
						<AgentSourceBadge source="hosted" compact />
						<span className="text-xs text-muted-foreground">
							{group.tiles.length} runtime{group.tiles.length === 1 ? "" : "s"}
						</span>
					</div>
					<AgentTileGrid tiles={group.tiles} />
				</section>
			))}

			{dedupedSelfManaged.length > 0 ? (
				<section className="space-y-2">
					<div className="flex items-center gap-2 px-0.5">
						<span className="text-sm font-medium">Other agents</span>
					</div>
					<AgentTileGrid tiles={dedupedSelfManaged} />
				</section>
			) : null}

			{hosted.error ? <HostedUnavailableBanner /> : null}
		</div>
	);
}
