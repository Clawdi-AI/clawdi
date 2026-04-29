"use client";

import { AgentsCard, type AgentTile } from "@/components/dashboard/agents-card";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { useHostedAgentTiles } from "@/hosted/use-hosted-agent-tiles";

/**
 * Hosted-only branch of the dashboard's agent panel.
 *
 * Wraps `useHostedAgentTiles` (cross-origin to clawdi.ai's deploy
 * API) and the AgentsCard / OnboardingCard render decision into one
 * component so the entire hosted code path — including the
 * cross-origin client and the empty-state coupling between hosted
 * and self-managed counts — can be loaded via `next/dynamic`.
 *
 * OSS builds never include this file in their main bundle: the
 * dashboard page conditionally constructs the `dynamic(() => …)`
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
}: {
	selfManagedTiles: AgentTile[];
	envsLoading: boolean;
	selfManagedCount: number;
}) {
	const hosted = useHostedAgentTiles({ enabled: true });
	const agentTiles: AgentTile[] = [...hosted.tiles, ...selfManagedTiles];
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
				<OnboardingCard />
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
 * the `useHostedAgentTiles` cache with `HostedAgentsSection` via
 * TanStack Query, so it costs no extra network. Without this
 * component the page-level `hasAgents` check would only see
 * self-managed counts and a hosted-only user would never see the
 * secondary CTA.
 */
export function HostedSecondaryCTA({
	selfManagedCount,
	envsLoading,
}: {
	selfManagedCount: number;
	envsLoading: boolean;
}) {
	const hosted = useHostedAgentTiles({ enabled: true });
	// Loading: don't flash an empty slot then pop in. Wait for both
	// sources to settle before deciding whether to show the CTA.
	if (envsLoading || hosted.isLoading) return null;
	const hasAnyAgent = selfManagedCount > 0 || hosted.tiles.length > 0;
	return hasAnyAgent ? <OnboardingCard /> : null;
}
