"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import { BillingApiError, billingQueryRetry } from "@/hosted/billing/errors";
import { billingKeys, useHostedDeployments } from "@/hosted/billing/hooks";
import { claimedEnvIdsFromDeployments } from "@/hosted/use-hosted-agent-tiles";
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
		if (query.isPending && !query.data && !query.error) return null;
		if (query.error) return EMPTY_ENV_IDS;
		return envIdSet(query.data?.environment_ids);
	}, [enabled, query.data, query.error, query.isPending]);
}

/**
 * Reports cloud-api environment ids managed by hosted-only control planes.
 *
 * The OSS dashboard receives only this neutral ownership context. Deploy API
 * reads stay quarantined in `apps/web/src/hosted/`, and failures degrade to
 * empty ownership sets so connected-agent UX remains usable.
 */
export function HostedAgentOwnershipSensor({
	onChange,
}: {
	onChange: (ownership: AgentOwnership | null) => void;
}) {
	const access = useHostedProductAccess();
	const cloudQuery = useHostedDeployments({ enabled: access.canUseCloudAgents });
	const legacyEnvIds = useLegacyEnvIds();

	const cloudEnvIds = useMemo(() => {
		if (!access.canUseCloudAgents || !isDeployApiConfigured()) return EMPTY_ENV_IDS;
		if (cloudQuery.isPending && !cloudQuery.data && !cloudQuery.error) return null;
		if (cloudQuery.error) return EMPTY_ENV_IDS;
		return claimedEnvIdsFromDeployments(cloudQuery.data ?? []);
	}, [access.canUseCloudAgents, cloudQuery.data, cloudQuery.error, cloudQuery.isPending]);

	const ownership = useMemo<AgentOwnership | null>(() => {
		if (!cloudEnvIds || !legacyEnvIds) return null;
		return { cloudEnvIds, legacyEnvIds };
	}, [cloudEnvIds, legacyEnvIds]);

	useEffect(() => {
		onChange(ownership);
		return () => onChange(null);
	}, [ownership, onChange]);

	return null;
}
