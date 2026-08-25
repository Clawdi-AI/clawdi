"use client";

import { useMemo } from "react";
import { isDeployApiConfigured } from "@/hosted/billing/billing-client";
import { useHostedDeployments } from "@/hosted/billing/hooks";
import {
	type DeploymentFailureProjection,
	deploymentFailureProjection,
} from "@/hosted/deployment-failure";
import { resolveHostedInventory } from "@/hosted/hosted-agent-resolution";

/** Single query adapter for hosted-agent membership across every surface. */
export function useHostedDeploymentInventory({
	enabled = true,
	pollBillingRecoveryFor = null,
	eventStreamActive = false,
}: {
	enabled?: boolean;
	pollBillingRecoveryFor?: string | null;
	eventStreamActive?: boolean;
} = {}) {
	const configured = isDeployApiConfigured();
	const query = useHostedDeployments({
		enabled,
		pollBillingRecoveryFor,
		eventStreamActive,
	});
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
	const deploymentFailures = useMemo(() => {
		const failures = new Map<string, DeploymentFailureProjection>();
		for (const deployment of resolution.deployments ?? []) {
			const failure = deploymentFailureProjection(deployment);
			if (failure) failures.set(deployment.resource.id, failure);
		}
		return failures;
	}, [resolution.deployments]);

	return {
		...resolution,
		deploymentFailures,
		deploymentTransitions: query.deploymentTransitions,
		isFetching: query.isFetching,
		refetch: query.refetch,
	};
}
