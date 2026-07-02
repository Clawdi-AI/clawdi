"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { parseHostedRuntimeTargetRouteId } from "@/hosted/agent-identity";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type { RebindAgentAiProviderRequest } from "@/hosted/billing/contracts";
import { toastBillingError } from "@/hosted/billing/errors";
import { billingKeys, useHostedDeployments } from "@/hosted/billing/hooks";
import { deploymentRuntimeTargets, type HostedRuntimeTarget } from "@/hosted/runtimes";

/**
 * Resolve the hosted deployment target that backs a cloud-api environment,
 * joined via `config_info.runtime_targets[agent_id].environment_id ===
 * environmentId`. Returns null for self-managed (CLI) agents.
 */
export function useAgentDeployment(environmentId: string) {
	const query = useHostedDeployments();
	const match = useMemo(() => {
		const explicitTarget = parseHostedRuntimeTargetRouteId(environmentId);
		const target = environmentId.toLowerCase();
		for (const d of query.data ?? []) {
			if (explicitTarget && d.id === explicitTarget.deploymentId) {
				const runtimeTarget = deploymentRuntimeTargets(d).find(
					(item) => item.id === explicitTarget.agentId,
				);
				if (runtimeTarget) return { deployment: d, target: runtimeTarget };
				continue;
			}
			const runtimeTarget = deploymentRuntimeTargets(d).find(
				(item) => (item.environmentId ?? "").toLowerCase() === target,
			);
			if (runtimeTarget) return { deployment: d, target: runtimeTarget };
		}
		return null;
	}, [query.data, environmentId]);

	// The env id to drive per-env queries (sessions, channel links). For an
	// env-id route it's the route param itself; for a deployment-id route
	// (post-deploy redirect) resolve to a real cloud-api env id from the
	// deployment, falling back to the route param while provisioning hasn't
	// minted env ids yet.
	const resolvedEnvId = useMemo(() => {
		if (!match || match.target?.environmentId) return match?.target?.environmentId ?? environmentId;
		return environmentId;
	}, [match, environmentId]);

	return {
		deployment: match?.deployment ?? null,
		runtimeTarget: match?.target ?? null,
		environmentId: resolvedEnvId,
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		error: query.error,
	};
}

export function useSetAgentEnabled() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { id: string; agentId: string; enabled: boolean }) =>
			client.setAgentEnabled(vars.id, vars.agentId, vars.enabled),
		onSuccess: (_d, vars) => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			toast.success(vars.enabled ? "Runtime enabled" : "Runtime disabled");
		},
		onError: toastBillingError("Couldn't update runtime"),
	});
}

/** Re-bind the AI provider for the deployment's enabled runtimes (live). */
export function useSetAgentAiProvider() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (vars: {
			id: string;
			agentIds: string[];
			body: RebindAgentAiProviderRequest;
		}) => {
			let last: Awaited<ReturnType<typeof client.setAgentAiProvider>> | undefined;
			for (const agentId of vars.agentIds) {
				last = await client.setAgentAiProvider(vars.id, agentId, vars.body);
			}
			return last;
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: billingKeys.deployments }),
		onError: toastBillingError("Couldn't update provider"),
	});
}

export function useCreateTerminalSession() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (vars: { id: string; target: HostedRuntimeTarget }) =>
			client.createTerminalSession(vars.id, vars.target.id),
		onError: toastBillingError("Couldn't open terminal"),
	});
}

export function useDeploymentLifecycle() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { id: string; action: "restart" | "stop" | "start" }) => {
			if (vars.action === "restart") return client.restartDeployment(vars.id);
			if (vars.action === "stop") return client.stopDeployment(vars.id);
			return client.startDeployment(vars.id);
		},
		onSuccess: (_d, vars) => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			const msg =
				vars.action === "restart"
					? "Restarting agent…"
					: vars.action === "stop"
						? "Agent stopped"
						: "Agent started";
			toast.success(msg);
		},
		onError: toastBillingError("Action failed"),
	});
}

export function useDeleteDeployment() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => client.deleteDeployment(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: billingKeys.deployments }),
		onError: toastBillingError("Couldn't delete agent"),
	});
}
