"use client";

import { useMemo } from "react";
import { isDeployApiConfigured } from "@/hosted/billing/billing-client";
import { useHostedDeployments } from "@/hosted/billing/hooks";
import { resolveHostedInventory } from "@/hosted/hosted-agent-resolution";

/** Single query adapter for hosted-agent membership across every surface. */
export function useHostedDeploymentInventory({
	enabled = true,
	pollBillingRecoveryFor = null,
}: {
	enabled?: boolean;
	pollBillingRecoveryFor?: string | null;
} = {}) {
	const configured = isDeployApiConfigured();
	const query = useHostedDeployments({ enabled, pollBillingRecoveryFor });
	const resolution = useMemo(
		() =>
			resolveHostedInventory({
				enabled,
				configured,
				data: query.data,
				error: query.error,
				isPending: query.isPending,
			}),
		[configured, enabled, query.data, query.error, query.isPending],
	);

	return {
		...resolution,
		isFetching: query.isFetching,
		refetch: query.refetch,
	};
}
