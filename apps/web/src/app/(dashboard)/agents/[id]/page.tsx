"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { ConnectedAgentDetail } from "@/components/dashboard/connected-agent-detail";
import { Skeleton } from "@/components/ui/skeleton";
import { IS_HOSTED } from "@/lib/hosted";
import { useV2Access } from "@/lib/v2-access";

// Hosted builds route through `AgentHome`, which renders the manifest editor
// for agents backed by a hosted deployment and falls back to the connected
// (CLI) detail otherwise. OSS builds render the connected detail directly —
// the hosted chunk (and the deploy-API client it carries) never ships.
const AgentHome = IS_HOSTED
	? dynamic(() => import("@/hosted/agents/agent-home").then((m) => ({ default: m.AgentHome })))
	: null;

export default function AgentDetailPage() {
	const { id } = useParams<{ id: string }>();
	const v2Access = useV2Access();
	if (AgentHome && v2Access.isLoading) {
		return (
			<div className="space-y-4 px-4 py-2 lg:px-6">
				<Skeleton className="h-10 w-64" />
				<Skeleton className="h-9 w-full max-w-md" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}
	if (AgentHome && v2Access.canUseV2) return <AgentHome environmentId={id} />;
	return <ConnectedAgentDetail environmentId={id} />;
}
