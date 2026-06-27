"use client";

import { useSearchParams } from "next/navigation";
import { ConnectedAgentDetail } from "@/components/dashboard/connected-agent-detail";
import { Skeleton } from "@/components/ui/skeleton";
import { isCloudEnvId } from "@/hosted/agent-identity";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { HostedAgentDetail } from "@/hosted/agents/hosted-agent-detail";
import { BillingEmpty, BillingError } from "@/hosted/billing/components/state-views";
import type { AgentSectionId } from "@/lib/agent-routes";

/**
 * Agent home for hosted builds. An agent backed by a hosted deployment renders
 * the hosted agent detail (`HostedAgentDetail`); a connected agent — or one
 * we can't resolve to a deployment — falls back to the connected detail.
 * The deployment lookup is hosted-only data, so the whole branch lives here
 * behind the IS_HOSTED dynamic import.
 */
export function AgentHome({
	environmentId,
	section,
}: {
	environmentId: string;
	section: AgentSectionId;
}) {
	const searchParams = useSearchParams();
	const {
		deployment,
		environmentId: resolvedEnvId,
		matchedRuntime,
		isLoading,
		isFetching,
		error,
	} = useAgentDeployment(environmentId);
	const requestedHostedAgent =
		searchParams.get("source") === "on-clawdi" || !isCloudEnvId(environmentId);

	// Hold a skeleton until the deployment lookup settles, so a hosted agent
	// doesn't flash the connected detail (and fire its queries) first.
	if (isLoading || (requestedHostedAgent && !deployment && isFetching)) {
		return (
			<div data-hosted="true" className="space-y-4 px-4 lg:px-6 py-2">
				<Skeleton className="h-10 w-64" />
				<Skeleton className="h-9 w-full max-w-md" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (error && requestedHostedAgent) {
		return (
			<div data-hosted="true" className="space-y-4 px-4 py-2 lg:px-6">
				<BillingError error={error} title="Couldn’t load hosted agent" />
			</div>
		);
	}

	if (deployment) {
		// Scope the detail to a single runtime. Prefer the env's matched runtime;
		// fall back to the first enabled one (e.g. when the route used a
		// deployment id, or matched a non-UI env like codex).
		const ci = deployment.config_info;
		const runtime: "openclaw" | "hermes" =
			matchedRuntime === "hermes"
				? "hermes"
				: matchedRuntime === "openclaw"
					? "openclaw"
					: ci?.enable_openclaw
						? "openclaw"
						: "hermes";
		return (
			<HostedAgentDetail
				environmentId={resolvedEnvId}
				deployment={deployment}
				runtime={runtime}
				section={section}
			/>
		);
	}

	if (requestedHostedAgent) {
		return (
			<div data-hosted="true" className="space-y-4 px-4 py-2 lg:px-6">
				<BillingEmpty
					title="Hosted agent not found"
					description="This hosted agent may still be provisioning or may have been removed."
				/>
			</div>
		);
	}

	return <ConnectedAgentDetail environmentId={environmentId} section={section} />;
}
