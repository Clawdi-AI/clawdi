"use client";

import { lazy, Suspense } from "react";
import {
	ConnectedAgentDetail,
	ConnectedAgentDetailSkeleton,
} from "@/components/dashboard/connected-agent-detail";
import { loadHostedAgentHome } from "@/lib/agent-home-loader";
import type { AgentRouteSearch, AgentSectionId } from "@/lib/agent-routes";

// Hosted builds route through `AgentHome`, which renders hosted agent detail
// for agents backed by a hosted deployment and falls back to the connected
// detail otherwise. OSS builds render the connected detail directly —
// the hosted chunk (and the deploy-API client it carries) never ships.
const agentHomeLoader = loadHostedAgentHome;
const AgentHome = agentHomeLoader
	? lazy(() => agentHomeLoader().then((module) => ({ default: module.AgentHome })))
	: null;

export function AgentDetailClient({
	environmentId,
	section,
	routeSearch,
	standalone = false,
}: {
	environmentId: string;
	section: AgentSectionId;
	routeSearch: AgentRouteSearch;
	standalone?: boolean;
}) {
	if (AgentHome) {
		return (
			<Suspense fallback={<ConnectedAgentDetailSkeleton hosted section={section} />}>
				<AgentHome
					environmentId={environmentId}
					section={section}
					routeSearch={routeSearch}
					standalone={standalone}
				/>
			</Suspense>
		);
	}
	return <ConnectedAgentDetail environmentId={environmentId} section={section} />;
}
