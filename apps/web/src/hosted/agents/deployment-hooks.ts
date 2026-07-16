"use client";

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { deleteDeploymentToastDecision } from "@/hosted/agents/delete-deployment-toast.logic";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type {
	HostedDeployment,
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
 * the agent tiles use). Duplicate joins remain unresolved until an explicit
 * deployment selector is present.
 */
export function useAgentDeployment(environmentId: string, deploymentSelector?: string | null) {
	const query = useHostedDeployments({ pollWalletDunningFor: deploymentSelector ?? environmentId });
	const resolution = useMemo(
		() => resolveAgentDeployment(query.data ?? [], environmentId, deploymentSelector),
		[query.data, environmentId, deploymentSelector],
	);
	const match = resolution.match;

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
		ambiguousMatches: resolution.ambiguousMatches,
		environmentId: resolvedEnvId,
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		error: query.error,
		refetch: query.refetch,
	};
}

export type AgentDeploymentMatch = {
	deployment: HostedDeployment;
	runtime: string | null;
};

export type AgentDeploymentResolution = {
	match: AgentDeploymentMatch | null;
	ambiguousMatches: AgentDeploymentMatch[];
};

export function resolveAgentDeployment(
	deployments: readonly HostedDeployment[],
	environmentId: string,
	deploymentSelector?: string | null,
): AgentDeploymentResolution {
	const target = environmentId.toLowerCase();
	// Direct deployment-id match: the post-deploy redirect lands on
	// `/agents/<deployment.id>` because cloud-api env ids aren't minted until
	// provisioning finishes — resolve by id, not just the env join.
	const direct = deployments.find((deployment) => deployment.id.toLowerCase() === target);
	if (direct) {
		return { match: { deployment: direct, runtime: null }, ambiguousMatches: [] };
	}

	const matches: AgentDeploymentMatch[] = [];
	for (const deployment of deployments) {
		const envs = deployment.config_info?.clawdi_cloud_environments ?? {};
		const runtime = Object.entries(envs).find(
			([, value]) => (value ?? "").toLowerCase() === target,
		);
		if (runtime) matches.push({ deployment, runtime: runtime[0] });
	}

	if (deploymentSelector) {
		const selector = deploymentSelector.toLowerCase();
		const selected = matches.find((item) => item.deployment.id.toLowerCase() === selector);
		if (selected) return { match: selected, ambiguousMatches: [] };
	}

	if (matches.length === 1) return { match: matches[0], ambiguousMatches: [] };
	return { match: null, ambiguousMatches: matches };
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
