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
import { billingKeys } from "@/hosted/billing/hooks";
import { resolveAgentDeployment } from "@/hosted/hosted-agent-resolution";
import { deploymentRuntime, runtimeEnvironmentId } from "@/hosted/runtimes";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";

const SETTLING_REFRESH_DELAYS_MS = [2_000, 10_000, 20_000, 30_000] as const;

export function invalidateDeploymentSnapshots(qc: QueryClient) {
	void qc.invalidateQueries({ queryKey: billingKeys.deployments });
	void qc.invalidateQueries({ queryKey: ["agents"] });
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
 * Resolve the hosted deployment that backs a cloud-api environment using the
 * stored environment id projected by the deploy API. An explicit deployment
 * selector disambiguates duplicate inventory rows.
 */
export function useAgentDeployment(environmentId: string, deploymentSelector?: string | null) {
	const inventory = useHostedDeploymentInventory({
		pollBillingRecoveryFor: deploymentSelector ?? environmentId,
	});
	const resolution = useMemo(
		() => resolveAgentDeployment(inventory.deployments ?? [], environmentId, deploymentSelector),
		[inventory.deployments, environmentId, deploymentSelector],
	);
	const match = resolution.match;

	// The env id to drive per-env queries (sessions, channel links). For an
	// env-id route it's the route param itself; for a deployment-id route
	// (post-deploy redirect) resolve to the stored cloud-api env id, falling back
	// to the route param while provisioning has not projected an env id yet.
	const resolvedEnvId = useMemo(() => {
		if (!match || match.runtime) return environmentId;
		const runtime = deploymentRuntime(match.deployment);
		return runtimeEnvironmentId(match.deployment, runtime) || environmentId;
	}, [match, environmentId]);

	return {
		deployment: match?.deployment ?? null,
		matchedRuntime: match?.runtime ?? null,
		ambiguousMatches: resolution.ambiguousMatches,
		environmentId: resolvedEnvId,
		inventoryStatus: inventory.status,
		membershipResolved: inventory.status === "resolved",
		isLoading: inventory.status === "loading" && !inventory.hasSnapshot,
		isFetching: inventory.isFetching,
		error: inventory.error,
		refetch: inventory.refetch,
	};
}

export type {
	AgentDeploymentMatch,
	AgentDeploymentResolution,
} from "@/hosted/hosted-agent-resolution";
export { resolveAgentDeployment } from "@/hosted/hosted-agent-resolution";

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
			scheduleDeploymentSettlingRefresh(qc);
			toast.success("Language and timezone updated");
		},
		onError: toastAgentLanguageTimezoneError,
		onSettled: () => invalidateDeploymentSnapshots(qc),
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
		onError: toastAiProviderRebindError,
		onSettled: () => invalidateDeploymentSnapshots(qc),
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
			if (isLifecycleStateConflict(error)) {
				toast.error("Agent state changed", {
					description:
						"The deployment state changed before the action ran. We refreshed the controls.",
				});
				return;
			}
			toast.error("Couldn't update lifecycle", { description: normalizeBillingError(error) });
		},
		onSettled: () => invalidateDeploymentSnapshots(qc),
	});
}

export function useDeleteDeployment() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => client.deleteDeployment(id),
		onSuccess: (result) => {
			scheduleDeploymentSettlingRefresh(qc);
			const decision = deleteDeploymentToastDecision(result);
			if (decision.tone === "warning") {
				toast.warning(decision.title, { description: decision.description });
				return;
			}
			toast.success(decision.title, { description: decision.description });
		},
		onError: toastBillingError("Couldn't delete agent"),
		onSettled: () => invalidateDeploymentSnapshots(qc),
	});
}
