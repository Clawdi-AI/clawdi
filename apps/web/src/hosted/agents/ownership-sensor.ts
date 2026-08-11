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
import type { LegacyHostedAccessStatus } from "@/lib/hosted-product-access-model";

const EMPTY_ENV_IDS: ReadonlySet<string> = new Set();

function envIdSet(ids: readonly string[] | undefined): ReadonlySet<string> {
	const set = new Set<string>();
	for (const id of ids ?? []) {
		const normalized = normalizeAgentEnvId(id);
		if (normalized) set.add(normalized);
	}
	return set;
}

export function resolveLegacyEnvIds(
	accessStatus: LegacyHostedAccessStatus,
	environmentIds: readonly string[] | undefined,
	error: Error | null,
): {
	envIds: ReadonlySet<string> | null;
	error: Error | null;
	isLoading: boolean;
} {
	if (accessStatus === "disabled") {
		return { envIds: EMPTY_ENV_IDS, error: null, isLoading: false };
	}
	if (accessStatus === "unresolved") {
		return { envIds: null, error, isLoading: error === null };
	}
	if (environmentIds !== undefined) {
		return { envIds: envIdSet(environmentIds), error: null, isLoading: false };
	}
	return { envIds: null, error, isLoading: error === null };
}

export function useLegacyEnvIds() {
	const access = useHostedProductAccess();
	const client = useBillingClient();
	const accessStatus = isDeployApiConfigured() ? access.legacyHostedAccessStatus : "disabled";
	const enabled = accessStatus === "enabled";
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

	const resolution = useMemo(() => {
		let error = query.error;
		if (accessStatus === "unresolved") {
			error =
				access.error == null
					? null
					: access.error instanceof Error
						? access.error
						: new Error("Hosted product access check failed");
		}
		// A successful access profile can authoritatively disable v1. When it
		// enables v1, only endpoint data (fresh or cached) resolves ownership;
		// loading and every error stay unresolved so destructive consumers fail
		// closed instead of treating a live legacy agent as connected.
		return resolveLegacyEnvIds(accessStatus, query.data?.environment_ids, error);
	}, [access.error, accessStatus, query.data, query.error]);
	return {
		...resolution,
		refetch: async () => {
			if (accessStatus === "unresolved") {
				await access.refetch();
			} else if (accessStatus === "enabled") {
				await query.refetch();
			}
		},
	};
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
	const legacy = useLegacyEnvIds();

	const cloudEnvIds = useMemo(
		() => claimedEnvIdsFromDeployments(cloudInventory.deployments ?? []),
		[cloudInventory.deployments],
	);

	const ownership = useMemo<AgentOwnership>(
		() => ({
			cloudEnvIds,
			legacyEnvIds: legacy.envIds ?? EMPTY_ENV_IDS,
			isResolved: cloudInventory.status === "resolved" && legacy.envIds !== null,
		}),
		[cloudEnvIds, cloudInventory.status, legacy.envIds],
	);

	useEffect(() => {
		onChange(ownership);
		return () => onChange(null);
	}, [ownership, onChange]);

	return null;
}
