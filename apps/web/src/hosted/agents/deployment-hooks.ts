"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type { RebindAgentAiProviderRequest } from "@/hosted/billing/contracts";
import { toastBillingError } from "@/hosted/billing/errors";
import { billingKeys, useHostedDeployments } from "@/hosted/billing/hooks";

/**
 * Resolve the hosted deployment that backs a cloud-api environment, joined via
 * `config_info.clawdi_cloud_environments[runtime] === environmentId` (same join
 * the agent tiles use). Returns null for self-managed (CLI) agents.
 */
export function useAgentDeployment(environmentId: string) {
	const query = useHostedDeployments();
	const match = useMemo(() => {
		const target = environmentId.toLowerCase();
		for (const d of query.data ?? []) {
			// Direct deployment-id match: the post-deploy redirect lands on
			// `/agents/<deployment.id>` because cloud-api env ids aren't minted
			// until provisioning finishes — resolve by id, not just the env join.
			if (d.id.toLowerCase() === target) return { deployment: d, runtime: null };
			const envs = d.config_info?.clawdi_cloud_environments ?? {};
			const runtime = Object.entries(envs).find(([, v]) => (v ?? "").toLowerCase() === target);
			if (runtime) return { deployment: d, runtime: runtime[0] };
		}
		return null;
	}, [query.data, environmentId]);

	// The env id to drive per-env queries (sessions, channel links). For an
	// env-id route it's the route param itself; for a deployment-id route
	// (post-deploy redirect) resolve to a real cloud-api env id from the
	// deployment, falling back to the route param while provisioning hasn't
	// minted env ids yet.
	const resolvedEnvId = useMemo(() => {
		if (!match || match.runtime) return environmentId;
		const envs = match.deployment.config_info?.clawdi_cloud_environments ?? {};
		return envs.openclaw || envs.hermes || envs.codex || Object.values(envs)[0] || environmentId;
	}, [match, environmentId]);

	return {
		deployment: match?.deployment ?? null,
		matchedRuntime: match?.runtime ?? null,
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
		mutationFn: (vars: { id: string; agentType: string; enabled: boolean }) =>
			client.setAgentEnabled(vars.id, vars.agentType, vars.enabled),
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
			agentTypes: string[];
			body: RebindAgentAiProviderRequest;
		}) => {
			let last: Awaited<ReturnType<typeof client.setAgentAiProvider>> | undefined;
			for (const agentType of vars.agentTypes) {
				last = await client.setAgentAiProvider(vars.id, agentType, vars.body);
			}
			return last;
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: billingKeys.deployments }),
		onError: toastBillingError("Couldn't update provider"),
	});
}

export function useRenameDeployment() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { id: string; name: string }) => client.renameDeployment(vars.id, vars.name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			toast.success("Agent renamed");
		},
		onError: toastBillingError("Couldn't rename agent"),
	});
}

export function useOnboardAgent() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { id: string; agentType: string }) =>
			client.onboardAgent(vars.id, vars.agentType),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			toast.success("Runtime added");
		},
		onError: toastBillingError("Couldn't add runtime"),
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
