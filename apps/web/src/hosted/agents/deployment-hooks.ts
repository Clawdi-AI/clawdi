"use client";

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type { RebindAgentAiProviderRequest } from "@/hosted/billing/contracts";
import { BillingApiError, normalizeBillingError, toastBillingError } from "@/hosted/billing/errors";
import { billingKeys, useHostedDeployments } from "@/hosted/billing/hooks";

const SETTLING_REFRESH_DELAYS_MS = [2_000, 10_000, 20_000, 30_000] as const;

type AiProviderRebindFailure = {
	agentType: string;
	error: unknown;
};

class AiProviderRebindError extends Error {
	constructor(
		readonly succeeded: string[],
		readonly failures: AiProviderRebindFailure[],
	) {
		super("AI provider rebind failed for one or more runtimes");
		this.name = "AiProviderRebindError";
	}
}

function invalidateDeploymentSnapshots(qc: QueryClient) {
	qc.invalidateQueries({ queryKey: billingKeys.deployments });
	qc.invalidateQueries({ queryKey: ["agents"] });
}

function scheduleDeploymentSettlingRefresh(qc: QueryClient) {
	for (const delay of SETTLING_REFRESH_DELAYS_MS) {
		globalThis.setTimeout(() => {
			void qc.invalidateQueries({ queryKey: billingKeys.deployments });
			void qc.invalidateQueries({ queryKey: ["agents"] });
		}, delay);
	}
}

function runtimeLabel(agentType: string): string {
	if (agentType === "codex") return "Codex";
	if (agentType === "openclaw") return "OpenClaw";
	if (agentType === "hermes") return "Hermes";
	return agentType;
}

function listRuntimeLabels(agentTypes: readonly string[]): string {
	return agentTypes.map(runtimeLabel).join(", ");
}

function isLifecycleStateConflict(error: unknown): boolean {
	if (!(error instanceof BillingApiError)) return false;
	return (
		error.status === 409 ||
		/invalid[_\s-]?state|state conflict|conflict|not (running|stopped|ready)|already/i.test(
			error.detail,
		)
	);
}

function toastAiProviderRebindError(error: unknown) {
	if (!(error instanceof AiProviderRebindError)) {
		toastBillingError("Couldn't update provider")(error);
		return;
	}

	const failed = listRuntimeLabels(error.failures.map((failure) => failure.agentType));
	const reason = normalizeBillingError(error.failures[0]?.error);
	if (error.succeeded.length > 0) {
		toast.error("Provider updated for some runtimes", {
			description: `Couldn't update ${failed}. ${reason}`,
		});
		return;
	}

	toast.error("Couldn't update provider", {
		description: `Couldn't update ${failed}. ${reason}`,
	});
}

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
		return envs.codex || environmentId;
	}, [match, environmentId]);

	return {
		deployment: match?.deployment ?? null,
		matchedRuntime: match?.runtime ?? null,
		environmentId: resolvedEnvId,
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		error: query.error,
		refetch: query.refetch,
	};
}

export function useSetAgentEnabled() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { id: string; agentType: string; enabled: boolean }) =>
			client.setAgentEnabled(vars.id, vars.agentType, vars.enabled),
		onSuccess: (_d, vars) => {
			invalidateDeploymentSnapshots(qc);
			scheduleDeploymentSettlingRefresh(qc);
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
			const succeeded: string[] = [];
			const failures: AiProviderRebindFailure[] = [];
			let last: Awaited<ReturnType<typeof client.setAgentAiProvider>> | undefined;
			for (const agentType of vars.agentTypes) {
				try {
					last = await client.setAgentAiProvider(vars.id, agentType, vars.body);
					succeeded.push(agentType);
				} catch (error) {
					failures.push({ agentType, error });
				}
			}
			if (failures.length > 0) {
				throw new AiProviderRebindError(succeeded, failures);
			}
			return last;
		},
		onSuccess: () => {
			invalidateDeploymentSnapshots(qc);
		},
		onError: (error) => {
			invalidateDeploymentSnapshots(qc);
			toastAiProviderRebindError(error);
		},
	});
}

export function useOnboardAgent() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { id: string; agentType: string }) =>
			client.onboardAgent(vars.id, vars.agentType),
		onSuccess: () => {
			invalidateDeploymentSnapshots(qc);
			scheduleDeploymentSettlingRefresh(qc);
			toast.success("Runtime added");
		},
		onError: toastBillingError("Couldn't add runtime"),
	});
}

export function useCreateTerminalSession() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (vars: { id: string }) => client.createTerminalSession(vars.id),
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
			invalidateDeploymentSnapshots(qc);
			scheduleDeploymentSettlingRefresh(qc);
			const msg =
				vars.action === "restart"
					? "Restarting agent…"
					: vars.action === "stop"
						? "Stopping agent…"
						: "Starting agent…";
			toast.success(msg);
		},
		onError: (error) => {
			qc.invalidateQueries({ queryKey: billingKeys.deployments });
			if (isLifecycleStateConflict(error)) {
				toast.error("Agent state changed", {
					description:
						"The deployment state changed before the action ran. We refreshed the controls.",
				});
				return;
			}
			toast.error("Couldn't update lifecycle", { description: normalizeBillingError(error) });
		},
	});
}

export function useDeleteDeployment() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => client.deleteDeployment(id),
		onSuccess: () => {
			invalidateDeploymentSnapshots(qc);
			scheduleDeploymentSettlingRefresh(qc);
		},
		onError: toastBillingError("Couldn't delete agent"),
	});
}
