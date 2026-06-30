"use client";

import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useMemo } from "react";
import { AgentsCard, selfManagedAgentTiles } from "@/components/dashboard/agents-card";
import { PageHeader } from "@/components/page-header";
import { unwrap, useApi } from "@/lib/api";
import { useV2Access } from "@/lib/v2-access";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

/**
 * Flat index of every agent — self-managed (connected) and, for hosted users,
 * hosted deployments. The 'Agents' breadcrumb parent and the
 * sidebar's "View all (N)" overflow both resolve here.
 *
 * Hosted merges deployments into the list via `HostedAgentsSection`;
 * the hosted-build gated dynamic import keeps that cross-origin chunk out of OSS
 * bundles (same pattern as the Overview agent panel).
 */
const HostedAgentsByCompute = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/hosted-agents-section").then((m) => ({
				default: m.HostedAgentsByCompute,
			})),
		)
	: null;

export default function AgentsIndexPage() {
	const api = useApi();
	const v2Access = useV2Access();
	const { data: environments, isLoading: envsLoading } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
		// Match the Overview/agent-detail 10s cadence so the live status badges
		// stay live on this list too.
		refetchInterval: 10_000,
	});

	const selfManagedTiles = useMemo(() => selfManagedAgentTiles(environments), [environments]);
	const selfManagedCount = selfManagedTiles.length;
	const hostedAccessLoading = Boolean(HostedAgentsByCompute && v2Access.isLoading);
	const hostedAgentsEnabled = Boolean(HostedAgentsByCompute && v2Access.canUseV2);

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<PageHeader title="Agents" description="Every agent connected to your account." />
			{hostedAccessLoading ? (
				<AgentsCard agents={selfManagedTiles} isLoading />
			) : hostedAgentsEnabled && HostedAgentsByCompute ? (
				<Suspense fallback={<AgentsCard agents={selfManagedTiles} isLoading />}>
					<HostedAgentsByCompute
						selfManagedTiles={selfManagedTiles}
						envsLoading={envsLoading}
						selfManagedCount={selfManagedCount}
						cloudEnvs={environments ?? []}
					/>
				</Suspense>
			) : (
				<AgentsCard agents={selfManagedTiles} isLoading={envsLoading} />
			)}
		</div>
	);
}
