"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import { BillingApiError, billingQueryRetry } from "@/hosted/billing/errors";
// (BillingApiError kept for the retry policy only — a 404 is not worth
// retrying, but it is NOT a definitive answer either; see useLegacyEnvIds.)
import { billingKeys } from "@/hosted/billing/hooks";
import { claimedEnvIdsFromDeployments } from "@/hosted/hosted-agent-resolution";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";
import type { AgentOwnership } from "@/lib/agent-ownership";
import { normalizeAgentEnvId } from "@/lib/agent-ownership";
import { useHostedProductAccess } from "@/lib/hosted-product-access";

const EMPTY_ENV_IDS: ReadonlySet<string> = new Set();

function envIdSet(ids: readonly string[] | undefined): ReadonlySet<string> {
	const set = new Set<string>();
	for (const id of ids ?? []) {
		const normalized = normalizeAgentEnvId(id);
		if (normalized) set.add(normalized);
	}
	return set;
}

export function useLegacyEnvIds(): ReadonlySet<string> | null {
	const access = useHostedProductAccess();
	const client = useBillingClient();
	const enabled = access.canUseLegacyHostedDashboard && isDeployApiConfigured();
	const query = useQuery({
		queryKey: billingKeys.legacyAgentEnvironments,
		enabled,
		queryFn: () => client.getLegacyAgentEnvironments(),
		retry: (failureCount, error) => {
			if (error instanceof BillingApiError && error.status === 404) return false;
			return billingQueryRetry(failureCount, error);
		},
		staleTime: 30_000,
	});

	return useMemo(() => {
		if (!enabled) return EMPTY_ENV_IDS;
		// Only data (fresh or stale cache) resolves the set. The endpoint has
		// no 404 in its success contract — users without live v1 deployments
		// get an empty list — so a 404 can only mean "route not deployed
		// yet" (rollout skew) and, like every other error, stays UNRESOLVED:
		// destructive consumers fail closed instead of treating live legacy
		// agents as connected.
		if (query.data) return envIdSet(query.data.environment_ids);
		return null;
	}, [enabled, query.data, query.error, query.isPending]);
}

/**
 * Reports cloud-api environment ids managed by hosted-only control planes.
 *
 * The OSS dashboard receives only this neutral ownership context. Deploy API
 * reads stay quarantined in `apps/web/src/hosted/`. A successful inventory
 * resolves connected classification. During loading or an error, last-known
 * external ids remain classified while every unknown id fails closed as
 * unresolved.
 */
export function HostedAgentOwnershipSensor({
	onChange,
}: {
	onChange: (ownership: AgentOwnership | null) => void;
}) {
	const cloudInventory = useHostedDeploymentInventory();
	const legacyEnvIds = useLegacyEnvIds();

	const cloudEnvIds = useMemo(
		() => claimedEnvIdsFromDeployments(cloudInventory.deployments ?? []),
		[cloudInventory.deployments],
	);

	const ownership = useMemo<AgentOwnership>(
		() => ({
			cloudEnvIds,
			legacyEnvIds: legacyEnvIds ?? EMPTY_ENV_IDS,
			isResolved: cloudInventory.status === "resolved" && legacyEnvIds !== null,
		}),
		[cloudEnvIds, cloudInventory.status, legacyEnvIds],
	);

	useEffect(() => {
		onChange(ownership);
		return () => onChange(null);
	}, [ownership, onChange]);

	return null;
}
