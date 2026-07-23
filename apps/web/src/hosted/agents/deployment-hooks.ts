"use client";

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	DeploymentConflictError,
	isNetworkError,
	normalizeBillingError,
	toastBillingError,
} from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/hooks";
import {
	forgetIdempotencyAttempt,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "@/hosted/billing/idempotency";
import { resolveAgentDeployment } from "@/hosted/hosted-agent-resolution";
import {
	defaultDeploymentRuntime,
	deploymentRuntime,
	type HostedRuntime,
	isHostedRuntime,
	runtimeConsoleUrl,
	runtimeEnvironmentId,
} from "@/hosted/runtimes";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";

const SETTLING_REFRESH_DELAYS_MS = [2_000, 10_000, 20_000, 30_000] as const;
export const RUNTIME_UI_SETTLING_POLL_INTERVAL_MS = 3_000;
export const RUNTIME_UI_SETTLING_TIMEOUT_MS = 5 * 60_000;

export type RuntimeUiSettlingTracker = {
	key: string;
	startedAtMs: number;
};

export type RuntimeUiSettlingPollState = {
	refetchInterval: number | false;
	timedOut: boolean;
	tracker: RuntimeUiSettlingTracker | null;
};

/**
 * A4 may report compute as running just before its runtime UI endpoint is
 * published. Keep that short-lived gap on the fast deployment-query cadence,
 * but stop rapid polling after the boot window. The normal inventory
 * reconciliation cadence remains active after this override returns false.
 */
export function runtimeUiSettlingPollState(
	deployment: HostedDeployment | null | undefined,
	runtime: HostedRuntime | null | undefined,
	tracker: RuntimeUiSettlingTracker | null,
	nowMs: number,
): RuntimeUiSettlingPollState {
	if (
		!deployment ||
		!runtime ||
		deployment.resource.status.summary_state !== "running" ||
		runtimeConsoleUrl(deployment, runtime)
	) {
		return { refetchInterval: false, timedOut: false, tracker: null };
	}

	const key = `${deployment.resource.id}:${deployment.resource.metadata.generation}:${runtime}`;
	const nextTracker =
		tracker?.key === key
			? tracker
			: {
					key,
					startedAtMs: runtimeUiSettlingStartedAtMs(deployment, nowMs),
				};
	const timedOut = nowMs - nextTracker.startedAtMs >= RUNTIME_UI_SETTLING_TIMEOUT_MS;
	return {
		refetchInterval: timedOut ? false : RUNTIME_UI_SETTLING_POLL_INTERVAL_MS,
		timedOut,
		tracker: nextTracker,
	};
}

function runtimeUiSettlingStartedAtMs(deployment: HostedDeployment, nowMs: number): number {
	const transitionTimes = deployment.resource.status.conditions.flatMap((condition) => {
		if (condition.type !== "Ready" || condition.status !== "True") {
			return [];
		}
		const parsed = Date.parse(condition.lastTransitionTime);
		return Number.isFinite(parsed) && parsed <= nowMs ? [parsed] : [];
	});
	return transitionTimes.length > 0 ? Math.max(...transitionTimes) : nowMs;
}

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

async function runStableDeploymentIntent<T>(
	prefix: string,
	value: unknown,
	run: (idempotencyKey: string) => Promise<T>,
): Promise<T> {
	const fingerprint = idempotencyFingerprint(value);
	const attempt = idempotencyAttemptFor(null, prefix, fingerprint, newIdempotencyKey);
	try {
		const result = await run(attempt.key);
		forgetIdempotencyAttempt(prefix, fingerprint);
		return result;
	} catch (error) {
		// A transport timeout may have happened after acceptance. Preserve the
		// intent key so a retry resumes the same LRO instead of issuing a new one.
		if (!isNetworkError(error)) forgetIdempotencyAttempt(prefix, fingerprint);
		throw error;
	}
}

function toastDeploymentConflict(error: unknown): boolean {
	if (!(error instanceof DeploymentConflictError)) return false;
	toast.error("Agent state changed", { description: normalizeBillingError(error) });
	return true;
}

/**
 * Resolve the hosted deployment that backs a cloud-api environment using the
 * stored environment id projected by the deploy API. An explicit deployment
 * selector disambiguates duplicate inventory rows.
 */
export function useAgentDeployment(environmentId: string, deploymentSelector?: string | null) {
	const runtimeUiSettlingTrackerRef = useRef<RuntimeUiSettlingTracker | null>(null);
	const updateRuntimeUiSettlingState = useCallback(
		(deployments: readonly HostedDeployment[] | null | undefined, nowMs: number) => {
			const resolution = resolveAgentDeployment(
				deployments ?? [],
				environmentId,
				deploymentSelector,
			);
			const match = resolution.match;
			const runtime =
				match?.runtime && isHostedRuntime(match.runtime)
					? match.runtime
					: match
						? defaultDeploymentRuntime(match.deployment)
						: null;
			const state = runtimeUiSettlingPollState(
				match?.deployment,
				runtime,
				runtimeUiSettlingTrackerRef.current,
				nowMs,
			);
			runtimeUiSettlingTrackerRef.current = state.tracker;
			return state;
		},
		[deploymentSelector, environmentId],
	);
	const additionalRefetchInterval = useCallback(
		(deployments: readonly HostedDeployment[] | undefined) =>
			updateRuntimeUiSettlingState(deployments, Date.now()).refetchInterval,
		[updateRuntimeUiSettlingState],
	);
	const inventory = useHostedDeploymentInventory({
		pollBillingRecoveryFor: deploymentSelector ?? environmentId,
		additionalRefetchInterval,
	});
	const resolution = useMemo(
		() => resolveAgentDeployment(inventory.deployments ?? [], environmentId, deploymentSelector),
		[inventory.deployments, environmentId, deploymentSelector],
	);
	const match = resolution.match;
	const runtimeUiSettling = updateRuntimeUiSettlingState(inventory.deployments, Date.now());

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
		runtimeUiSettlingTimedOut: runtimeUiSettling.timedOut,
		error: inventory.error,
		refetch: inventory.refetch,
	};
}

export type {
	AgentDeploymentMatch,
	AgentDeploymentResolution,
} from "@/hosted/hosted-agent-resolution";
export { resolveAgentDeployment } from "@/hosted/hosted-agent-resolution";

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
		mutationFn: (vars: { id: string; action: "restart" | "stop" | "start" }) =>
			runStableDeploymentIntent("deployment-lifecycle", vars, (idempotencyKey) => {
				if (vars.action === "restart") {
					return client.restartDeployment(vars.id, idempotencyKey);
				}
				return client.setDeploymentDesiredState(
					vars.id,
					vars.action === "start" ? "running" : "stopped",
					idempotencyKey,
				);
			}),
		onSuccess: (_d, vars) => {
			scheduleDeploymentSettlingRefresh(qc);
			const msg =
				vars.action === "restart"
					? "Agent restarted"
					: vars.action === "stop"
						? "Agent stopped"
						: "Agent started";
			toast.success(msg);
		},
		onError: (error) => {
			if (toastDeploymentConflict(error)) return;
			toast.error("Couldn't update lifecycle", { description: normalizeBillingError(error) });
		},
		onSettled: () => invalidateDeploymentSnapshots(qc),
	});
}

export function useDeleteDeployment() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			runStableDeploymentIntent("deployment-delete", { action: "delete", id }, (key) =>
				client.deleteDeployment(id, key),
			),
		onSuccess: () => {
			scheduleDeploymentSettlingRefresh(qc);
			toast.success("Agent deleted");
		},
		onError: (error) => {
			if (toastDeploymentConflict(error)) return;
			toastBillingError("Couldn't delete agent")(error);
		},
		onSettled: () => invalidateDeploymentSnapshots(qc),
	});
}
