"use client";

import type { components } from "@clawdi/shared/api";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentSourceBadge } from "@/components/dashboard/agent-label";
import {
	AgentsCard,
	AgentTileGrid,
	HostedUnavailableBanner,
} from "@/components/dashboard/agents-card";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { SectionLabel } from "@/components/section-label";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useUnifiedAgentList } from "@/hosted/use-unified-agent-list";

type Env = components["schemas"]["AgentResponse"];

/**
 * Hosted-only branch of the dashboard's agent panel.
 *
 * Wraps `useUnifiedAgentList` (cross-origin to the deploy API) and the
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
	envsLoading,
	selfManagedError,
	onRetrySelfManaged,
	selfManagedCount,
	cloudEnvs,
	showCloudDeployments = true,
	showLegacyAgents = false,
}: {
	envsLoading: boolean;
	selfManagedError?: unknown;
	onRetrySelfManaged?: () => void;
	selfManagedCount: number;
	/**
	 * Cloud-api environments the parent already fetched for the
	 * self-managed grid. Passed through so hosted tiles can join
	 * to their daemon-sync row using the stored environment id projected
	 * by the deploy API and render the same status badge
	 * as self-managed tiles. Empty/missing envs is harmless — the
	 * matched-env lookup falls back to null and the tile still renders.
	 */
	cloudEnvs: Env[];
	showCloudDeployments?: boolean;
	showLegacyAgents?: boolean;
}) {
	const unified = useUnifiedAgentList({
		cloudEnvs,
		showCloudDeployments,
		showLegacyAgents,
	});
	const connectedTiles = unified.connectedTiles;
	const agentTiles = unified.tiles;
	// Empty state must consider BOTH sources of agents. Hidden behind
	// `!unified.error` so a transient hosted-fetch failure surfaces in
	// AgentsCard's error banner instead of dropping silently into the
	// onboarding hero.
	const isEmptyState =
		!envsLoading &&
		!selfManagedError &&
		selfManagedCount === 0 &&
		unified.hostedTiles.length === 0 &&
		connectedTiles.length === 0 &&
		!unified.isLoading &&
		!unified.error;
	return (
		<div data-hosted="true">
			{isEmptyState ? (
				<OnboardingCard variant="first-agent" />
			) : (
				<AgentsCard
					agents={agentTiles}
					isLoading={envsLoading}
					error={selfManagedError}
					onRetry={onRetrySelfManaged}
					hostedStatus={{
						isLoading: unified.isLoading,
						error: unified.error,
						onRetry: () => {
							void unified.refetch();
						},
						normalizer: billingErrorNormalizer,
					}}
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
	envsLoading,
	cloudEnvs,
	showCloudDeployments = true,
	showLegacyAgents = false,
}: {
	envsLoading: boolean;
	cloudEnvs: Env[];
	showCloudDeployments?: boolean;
	showLegacyAgents?: boolean;
}) {
	// Reuses the same hosted deployments TanStack Query cache
	// as `HostedAgentsSection` so passing cloudEnvs here is just
	// re-running the join, not re-fetching.
	const unified = useUnifiedAgentList({
		cloudEnvs,
		showCloudDeployments,
		showLegacyAgents,
	});
	const hasAnyAgent = unified.tiles.length > 0;
	if (hasAnyAgent) return <OnboardingCard variant="additional-agent" />;
	// Loading: don't flash an empty slot then pop in. Wait for pending
	// sources only when none has already proven there is an agent.
	if (envsLoading || unified.isLoading) return null;
	return null;
}

/**
 * The /agents index list. Hosted deployments render as one Clawdi Cloud agent
 * each; self-managed and legacy hosted agents get their own section.
 */
export function HostedAgentsByCompute({
	envsLoading,
	selfManagedError,
	onRetrySelfManaged,
	selfManagedCount,
	cloudEnvs,
	showCloudDeployments = true,
	showLegacyAgents = false,
}: {
	envsLoading: boolean;
	selfManagedError?: unknown;
	onRetrySelfManaged?: () => void;
	selfManagedCount: number;
	cloudEnvs: Env[];
	showCloudDeployments?: boolean;
	showLegacyAgents?: boolean;
}) {
	const unified = useUnifiedAgentList({
		cloudEnvs,
		showCloudDeployments,
		showLegacyAgents,
	});
	const hostedTiles = unified.hostedTiles;
	const connectedTiles = unified.connectedTiles;

	const isEmptyState =
		!envsLoading &&
		!selfManagedError &&
		selfManagedCount === 0 &&
		hostedTiles.length === 0 &&
		connectedTiles.length === 0 &&
		!unified.isLoading &&
		!unified.error;
	if (isEmptyState) {
		return (
			<div data-hosted="true">
				<OnboardingCard variant="first-agent" />
			</div>
		);
	}

	if (
		(envsLoading || unified.isLoading) &&
		hostedTiles.length === 0 &&
		connectedTiles.length === 0
	) {
		return (
			<div data-hosted="true">
				<AgentsCard agents={[]} isLoading />
			</div>
		);
	}

	return (
		<div data-hosted="true" className="space-y-6">
			{hostedTiles.length > 0 ? (
				<section className="space-y-2">
					<SectionLabel
						leading={<AgentSourceBadge source="hosted" compact />}
						count={`${hostedTiles.length} agent${hostedTiles.length === 1 ? "" : "s"}`}
					>
						Clawdi Cloud
					</SectionLabel>
					<AgentTileGrid tiles={hostedTiles} />
				</section>
			) : null}

			{connectedTiles.length > 0 ? (
				<section className="space-y-2">
					<SectionLabel>Other agents</SectionLabel>
					<AgentTileGrid tiles={connectedTiles} />
				</section>
			) : null}

			{selfManagedError ? (
				<section className="space-y-2">
					<SectionLabel>Other agents</SectionLabel>
					<ApiErrorPanel
						error={selfManagedError}
						onRetry={onRetrySelfManaged}
						title="Couldn't load agents"
					/>
				</section>
			) : null}

			{unified.error ? (
				<HostedUnavailableBanner
					error={unified.error}
					onRetry={() => {
						void unified.refetch();
					}}
					normalizer={billingErrorNormalizer}
				/>
			) : null}
		</div>
	);
}
