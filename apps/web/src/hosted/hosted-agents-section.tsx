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
 * Marker (`data-hosted="true"`) goes on a `display: contents`
 * wrapper so layout is unchanged but the OSS-clean test (and
 * runtime DOM inspection) can verify nothing escaped.
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
		<div data-hosted="true" className="contents">
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
