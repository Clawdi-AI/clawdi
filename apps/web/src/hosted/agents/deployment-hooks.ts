"use client";

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { retireRuntimeWindows } from "@/hosted/agents/runtime-window-lifecycle";
import {
	type AcceptedOperation,
	type DeploymentDeleteResult,
	useBillingClient,
} from "@/hosted/billing/billing-client";
import type {
	DeploymentDeleteRequest,
	DeploymentUpdateRequest,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";
import { DeploymentConflictError, isNetworkError } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/hooks";
import {
	forgetIdempotencyAttempt,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "@/hosted/billing/idempotency";
import {
	deploymentMutationErrorMessage,
	operationCancelErrorMessage,
} from "@/hosted/deployment-failure";
import type { DeploymentOperationVerb } from "@/hosted/deployment-status";
import { resolveAgentDeployment } from "@/hosted/hosted-agent-resolution";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";

const SETTLING_REFRESH_DELAYS_MS = [2_000, 10_000, 20_000, 30_000] as const;
const ACCEPTED_OPERATION_TRANSITIONS = {
	create: "creating",
	start: "starting",
	stop: "stopping",
	restart: "restarting",
	reset_runtime_ui_access: "restarting",
	update: "updating",
	migrate_runtime_context: "updating",
	plan_change: "updating",
	runtime_switch: "updating",
	migrate_image: "updating",
	rollback_image: "updating",
	rename: "updating",
	delete: "deleting",
} satisfies Record<DeploymentOperationVerb, HostedDeploymentStatus["summary_state"]>;

export function invalidateDeploymentSnapshots(qc: QueryClient) {
	void qc.invalidateQueries({ queryKey: billingKeys.deployments });
	void qc.invalidateQueries({ queryKey: ["get", "/v1/agents"] });
}

export function invalidateDeploymentDeleteSnapshots(qc: QueryClient) {
	invalidateDeploymentSnapshots(qc);
	void qc.invalidateQueries({ queryKey: billingKeys.subscriptions });
	void qc.invalidateQueries({ queryKey: billingKeys.reusableSubscriptions });
}

function scheduleDeploymentSettlingRefresh(qc: QueryClient) {
	for (const delay of SETTLING_REFRESH_DELAYS_MS) {
		globalThis.setTimeout(() => {
			invalidateDeploymentSnapshots(qc);
		}, delay);
	}
}

function scheduleDeploymentDeleteSettlingRefresh(qc: QueryClient) {
	for (const delay of SETTLING_REFRESH_DELAYS_MS) {
		globalThis.setTimeout(() => {
			invalidateDeploymentDeleteSnapshots(qc);
		}, delay);
	}
}

export function projectAcceptedDeploymentTransition(
	qc: QueryClient,
	accepted: AcceptedOperation,
	scheduleRefresh: (queryClient: QueryClient) => void = scheduleDeploymentSettlingRefresh,
) {
	const status = ACCEPTED_OPERATION_TRANSITIONS[accepted.operation.metadata.verb];
	qc.setQueryData<HostedDeployment[]>(billingKeys.deployments, (deployments) =>
		deployments?.map((deployment) =>
			deployment.resource.id === accepted.deploymentId
				? {
						...deployment,
						accepted_operation: accepted.operation,
						resource: {
							...deployment.resource,
							status:
								deployment.resource.status === null
									? null
									: {
											...deployment.resource.status,
											summary_state: status,
											failure: null,
										},
						},
					}
				: deployment,
		),
	);
	scheduleRefresh(qc);
}

/** Attempts to leave detail before accepted cache projection can hide it. */
export async function settleAcceptedDeploymentDelete(
	qc: QueryClient,
	accepted: DeploymentDeleteResult,
	dismissDetail: () => Promise<void> | void,
	scheduleRefresh: (queryClient: QueryClient) => void = scheduleDeploymentDeleteSettlingRefresh,
): Promise<boolean> {
	let detailDismissed = true;
	try {
		await dismissDetail();
	} catch {
		detailDismissed = false;
	}
	if (accepted.operation) {
		projectAcceptedDeploymentTransition(qc, accepted, scheduleRefresh);
	}
	return detailDismissed;
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
	toast.error("Agent state changed", { description: deploymentMutationErrorMessage(error) });
	return true;
}

/** Resolve the Hosted deployment bound to the canonical Agent UUID. */
export function useAgentDeployment(agentId: string) {
	const inventory = useHostedDeploymentInventory({
		pollBillingRecoveryFor: agentId,
	});
	const match = useMemo(
		() => resolveAgentDeployment(inventory.deployments ?? [], agentId),
		[inventory.deployments, agentId],
	);
	const deploymentId = match?.deployment.resource.id;
	const deploymentTransition = deploymentId
		? (inventory.deploymentTransitions.get(deploymentId) ?? null)
		: null;
	const deploymentFailure = deploymentId
		? (inventory.deploymentFailures.get(deploymentId) ?? null)
		: null;

	return {
		deployment: match?.deployment ?? null,
		inventoryDeployments: inventory.deployments,
		matchedRuntime: match?.runtime ?? null,
		environmentId: match?.deployment.agent_id ?? agentId,
		inventoryStatus: inventory.status,
		membershipResolved: inventory.status === "resolved",
		isLoading: inventory.status === "loading" && !inventory.hasSnapshot,
		isFetching: inventory.isFetching,
		deploymentTransition,
		deploymentTransitionTimedOut: deploymentTransition?.kind === "timed_out",
		deploymentTransitionEscalated: deploymentTransition?.kind === "escalated",
		deploymentFailure,
		error: inventory.error,
		refetch: inventory.refetch,
		retryDeploymentTransition: inventory.refetch,
	};
}

export type { AgentDeploymentMatch } from "@/hosted/hosted-agent-resolution";
export { resolveAgentDeployment } from "@/hosted/hosted-agent-resolution";

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
		onSuccess: (accepted, vars) => {
			projectAcceptedDeploymentTransition(qc, accepted);
			if (vars.action === "restart") {
				retireRuntimeWindows(accepted.deploymentId);
			}
			const msg =
				vars.action === "restart"
					? "Restarting…"
					: vars.action === "stop"
						? "Stopping…"
						: "Starting…";
			toast.message(msg);
		},
		onError: (error) => {
			if (toastDeploymentConflict(error)) return;
			toast.error("Couldn't update lifecycle", {
				description: deploymentMutationErrorMessage(error),
			});
		},
		onSettled: () => invalidateDeploymentSnapshots(qc),
	});
}

export function useResetRuntimeUiAccess() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { id: string }) =>
			runStableDeploymentIntent("runtime-ui-access-reset", vars, (idempotencyKey) =>
				client.resetRuntimeUiAccess(vars.id, idempotencyKey),
			),
		onSuccess: (accepted) => {
			projectAcceptedDeploymentTransition(qc, accepted);
			retireRuntimeWindows(accepted.deploymentId);
			toast.message("Resetting Runtime UI access…");
		},
		onError: (error) => {
			if (toastDeploymentConflict(error)) return;
			toast.error("Couldn't reset Runtime UI access", {
				description: deploymentMutationErrorMessage(error),
			});
		},
		onSettled: () => invalidateDeploymentSnapshots(qc),
	});
}

export function useDeleteDeployment(dismissDetail: () => Promise<void> | void) {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { id: string; request: DeploymentDeleteRequest; resourceVersion: string }) =>
			runStableDeploymentIntent(
				"deployment-delete",
				{ action: "delete", id: vars.id, request: vars.request },
				(key) => client.deleteDeployment(vars.id, vars.request, key, vars.resourceVersion),
			),
		onSuccess: async (accepted) => {
			const detailDismissed = await settleAcceptedDeploymentDelete(qc, accepted, dismissDetail);
			if (!detailDismissed) {
				toast.error("Agent removed, but navigation failed", {
					description: "Use Overview in the sidebar to continue.",
				});
			}
			retireRuntimeWindows(accepted.deploymentId);
			invalidateDeploymentDeleteSnapshots(qc);
			toast.message("Agent removed", {
				description: "Cleanup continues in the background.",
			});
		},
		onError: (error) => {
			if (toastDeploymentConflict(error)) return;
			toast.error("Couldn't delete agent", {
				description: deploymentMutationErrorMessage(error),
			});
		},
		onSettled: () => invalidateDeploymentSnapshots(qc),
	});
}

export function useUpdateDeployment() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { id: string; update: DeploymentUpdateRequest }) =>
			runStableDeploymentIntent("deployment-update", vars, (key) =>
				client.updateDeployment(vars.id, vars.update, key),
			),
		onSuccess: (accepted) => {
			projectAcceptedDeploymentTransition(qc, accepted);
			toast.message("Applying agent settings…");
		},
		onError: (error) => {
			if (toastDeploymentConflict(error)) return;
			toast.error("Couldn't update agent settings", {
				description: deploymentMutationErrorMessage(error),
			});
		},
		onSettled: () => invalidateDeploymentSnapshots(qc),
	});
}

/** Request cancellation of an in-flight accepted deployment operation. */
export function useCancelDeploymentOperation() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { operationName: string }) =>
			runStableDeploymentIntent("deployment-cancel", vars, (idempotencyKey) =>
				client.cancelDeploymentOperation(vars.operationName, idempotencyKey),
			),
		onSuccess: () => {
			toast.message("Cancellation requested", {
				description: "The change will be stopped. This page updates automatically.",
			});
		},
		onError: (error) => {
			if (toastDeploymentConflict(error)) return;
			toast.error("Couldn't cancel this change", {
				description: operationCancelErrorMessage(error),
			});
		},
		onSettled: () => invalidateDeploymentSnapshots(qc),
	});
}
