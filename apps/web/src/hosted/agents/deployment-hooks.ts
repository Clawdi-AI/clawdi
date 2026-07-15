"use client";

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { deleteDeploymentToastDecision } from "@/hosted/agents/delete-deployment-toast.logic";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type {
	RebindAgentAiProviderRequest,
	SetAgentEnabledRequest,
} from "@/hosted/billing/contracts";
import { normalizeHostedLanguage } from "@/hosted/billing/deploy/language-timezone-controls";
import { BillingApiError, normalizeBillingError, toastBillingError } from "@/hosted/billing/errors";
import { billingKeys, useHostedDeployments } from "@/hosted/billing/hooks";
import { deploymentRuntime, runtimeEnvironmentId } from "@/hosted/runtimes";

const SETTLING_REFRESH_DELAYS_MS = [2_000, 10_000, 20_000, 30_000] as const;

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
	toast.error("Couldn't update provider", { description: normalizeBillingError(error) });
}

function toastAgentLanguageTimezoneError(error: unknown) {
	toast.error("Couldn't update language and timezone", {
		description: normalizeBillingError(error),
	});
}

/**
 * Resolve the hosted deployment that backs a cloud-api environment, joined via
 * `config_info.clawdi_cloud_environments[runtime] === environmentId` (same join
 * the agent tiles use). Returns null for self-managed (CLI) agents.
 */
export function useAgentDeployment(environmentId: string) {
	const query = useHostedDeployments({ pollWalletDunningFor: environmentId });
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
		const runtime = deploymentRuntime(match.deployment);
		return runtimeEnvironmentId(match.deployment.config_info, runtime) || environmentId;
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

export function useSetAgentLanguageTimezone() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (vars: {
			id: string;
			agentType: string;
			language: string;
			timezone: string;
		}) => {
			const body: SetAgentEnabledRequest = {
				enabled: true,
				language: normalizeHostedLanguage(vars.language),
				timezone: vars.timezone.trim() || null,
			};
			return client.setAgentLanguageTimezone(vars.id, vars.agentType, body);
		},
		onSuccess: () => {
			invalidateDeploymentSnapshots(qc);
			scheduleDeploymentSettlingRefresh(qc);
			toast.success("Language and timezone updated");
		},
		onError: (error) => {
			invalidateDeploymentSnapshots(qc);
			toastAgentLanguageTimezoneError(error);
		},
	});
}

/** Re-bind the AI provider pool and primary model for deployment runtimes (live). */
export function useSetAgentAiProvider() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (vars: {
			id: string;
			agentType: string;
			body: RebindAgentAiProviderRequest;
		}) => {
			return client.setAgentAiProvider(vars.id, vars.agentType, vars.body);
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

export function useCreateTerminalSession() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (vars: { id: string }) => client.createTerminalSession(vars.id),
		onError: toastBillingError("Couldn't open terminal"),
	});
}

export function useCreateRuntimeUiRedemption() {
	const client = useBillingClient();
	return useMutation({
		mutationFn: (vars: { id: string }) => client.createRuntimeUiRedemption(vars.id),
		onError: toastBillingError("Couldn't open runtime UI"),
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
		onSuccess: (result) => {
			invalidateDeploymentSnapshots(qc);
			scheduleDeploymentSettlingRefresh(qc);
			const decision = deleteDeploymentToastDecision(result);
			if (decision.tone === "warning") {
				toast.warning(decision.title, { description: decision.description });
				return;
			}
			toast.success(decision.title, { description: decision.description });
		},
		onError: toastBillingError("Couldn't delete agent"),
	});
}
