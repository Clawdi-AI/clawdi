"use client";

import { lazy, Suspense } from "react";
import {
	ConnectedAgentDetail,
	ConnectedAgentDetailSkeleton,
} from "@/components/dashboard/connected-agent-detail";
import type { AgentRouteSearch, AgentSectionId } from "@/lib/agent-routes";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// Hosted builds route through `AgentHome`, which renders hosted agent detail
// for agents backed by a hosted deployment and falls back to the connected
// detail otherwise. OSS builds render the connected detail directly —
// the hosted chunk (and the deploy-API client it carries) never ships.
const AgentHome = IS_HOSTED_BUILD
	? lazy(() => import("@/hosted/agents/agent-home").then((m) => ({ default: m.AgentHome })))
	: null;

export function AgentDetailClient({
	environmentId,
	section,
	routeSearch,
}: {
	environmentId: string;
	section: AgentSectionId;
	routeSearch: AgentRouteSearch;
}) {
	if (AgentHome) {
		return (
			<Suspense fallback={<ConnectedAgentDetailSkeleton hosted />}>
				<AgentHome environmentId={environmentId} section={section} routeSearch={routeSearch} />
			</Suspense>
		);
	}
	return (
		<ConnectedAgentDetail
			environmentId={environmentId}
			section={section}
			routeSearch={routeSearch}
		/>
	);
}
