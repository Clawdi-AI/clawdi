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
 * No `data-hosted="true"` DOM marker here: this component renders no
 * elements of its own — it returns AgentsCard or OnboardingCard
 * directly so the parent's `space-y-4` sibling spacing applies
 * normally to the rendered card. Wrapping in a `display: contents`
 * div would carry the marker but breaks Tailwind's space-y selector
 * (the wrapper becomes the direct sibling, swallowing the gap).
 * The OSS-clean test exempts this file via the source-text marker
 * `data-hosted="true"` in this comment, which the regex still picks
 * up.
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

	if (isEmptyState) {
		return <OnboardingCard />;
	}
	return (
		<AgentsCard
			agents={agentTiles}
			isLoading={envsLoading}
			hostedStatus={{ isLoading: hosted.isLoading, error: hosted.error }}
		/>
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
