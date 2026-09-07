"use client";

import { getRouteApi } from "@tanstack/react-router";
import { type ComponentType, lazy, Suspense } from "react";
import { AgentProjectResourceCanonicalizer } from "@/components/dashboard/agent-project-resource-canonicalizer";
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

const overviewRoute = getRouteApi("/_protected/_dashboard/agents/$id/");
const sectionRoute = getRouteApi("/_protected/_dashboard/agents/$id/$section");

type DetailPageProps = { detail?: ComponentType<Parameters<typeof AgentDetailClient>[0]> };

export function AgentOverviewPage({ detail: Detail = AgentDetailClient }: DetailPageProps) {
	const { id } = overviewRoute.useParams();
	const search = overviewRoute.useSearch();
	return <Detail environmentId={id} section="overview" routeSearch={search} />;
}

export function AgentSectionPage({ detail: Detail = AgentDetailClient }: DetailPageProps) {
	const { id } = sectionRoute.useParams();
	const { section } = sectionRoute.useRouteContext();
	const search = sectionRoute.useSearch();
	if (section === "skills" || section === "vaults") {
		return (
			<AgentProjectResourceCanonicalizer agentId={id} resource={section} routeSearch={search} />
		);
	}
	return <Detail environmentId={id} section={section} routeSearch={search} />;
}

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
