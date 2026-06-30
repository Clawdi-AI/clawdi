"use client";

import { lazy, Suspense } from "react";
import { ConnectedAgentDetail } from "@/components/dashboard/connected-agent-detail";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentSectionId } from "@/lib/agent-routes";
import { useV2Access } from "@/lib/v2-access";

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
}: {
	environmentId: string;
	section: AgentSectionId;
}) {
	const v2Access = useV2Access();
	if (AgentHome && v2Access.isLoading) {
		return <AgentDetailSkeleton />;
	}
	if (AgentHome && v2Access.canUseV2) {
		return (
			<Suspense fallback={<AgentDetailSkeleton />}>
				<AgentHome environmentId={environmentId} section={section} />
			</Suspense>
		);
	}
	return <ConnectedAgentDetail environmentId={environmentId} section={section} />;
}

function AgentDetailSkeleton() {
	return (
		<div className="space-y-4 px-4 py-2 lg:px-6">
			<Skeleton className="h-10 w-64" />
			<Skeleton className="h-9 w-full max-w-md" />
			<Skeleton className="h-48 w-full" />
		</div>
	);
}
