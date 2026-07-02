"use client";

import { useEffect, useMemo } from "react";
import { useHostedDeployments } from "@/hosted/billing/hooks";
import { claimedEnvIdsFromDeployments } from "@/hosted/use-hosted-agent-tiles";

/**
 * Renders nothing; reports which cloud-api env ids are claimed by Cloud
 * deploy-API deployments. The OSS sidebar needs this to tell Cloud
 * runtime-agents apart from legacy v1 agents (both are hosted_managed in
 * cloud-api), but the deploy-API client is hosted-only code — so the
 * sidebar mounts this sensor through its gated lazy import and keeps the
 * set in local state. Reports `null` while the deployments query hasn't
 * resolved (and on unmount), meaning "unknown — keep the default chrome".
 *
 * Shares the deployments TanStack Query cache with `useHostedAgentTiles`
 * and `AgentHome`, so mounting it costs no extra network.
 */
export function HostedClaimedEnvsSensor({
	onChange,
}: {
	onChange: (claimed: ReadonlySet<string> | null) => void;
}) {
	const query = useHostedDeployments();
	const claimed = useMemo(
		() => (query.data ? claimedEnvIdsFromDeployments(query.data) : null),
		[query.data],
	);
	useEffect(() => {
		onChange(claimed);
		return () => onChange(null);
	}, [claimed, onChange]);
	return null;
}
