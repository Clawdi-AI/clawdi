"use client";

import {
	type DeployPaths,
	extractApiDetail,
	unwrapDeploymentEventStreamSnapshotHandoff,
	unwrapDeploymentList,
} from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { useMemo } from "react";
import { hostedApiBaseUrl } from "@/hosted/billing/billing-url";
import type {
	CheckoutRequest,
	ComputeFixPaymentRequest,
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeRequest,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionQuoteRequest,
	ComputeSubscriptionResumeRequest,
	DeploymentDesiredLifecycle,
	DeploymentOperation,
	DeploymentUpdateRequest,
	HostedDeployment,
	HostedDeployRequestStatus,
	HostedEventStreamSnapshotHandoff,
	PortalRequest,
	WalletAutoReloadRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import {
	BillingApiError,
	BillingNetworkError,
	DeploymentConflictError,
} from "@/hosted/billing/errors";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";
import { isDeployApiConfigured } from "@/lib/hosted-api";

const BASE_URL = env.VITE_CLAWDI_DEPLOY_API_URL;
const ROOT_BASE_URL = hostedApiBaseUrl(BASE_URL);

const REQUEST_TIMEOUT_MS = 20_000;

export { isDeployApiConfigured };

type DeployResult<T> = { data?: T; error?: unknown; response: Response };
type BillingFetch = (request: Request) => Promise<Response>;
type BillingAuthTokenGetter = () => Promise<string | null | undefined>;

export type DeploymentIntentResult = {
	deploymentId: string;
	operation: DeploymentOperation | null;
};

export type BillingClientOptions = {
	fetch?: BillingFetch;
	operationPollIntervalMs?: number;
	operationPollLimit?: number;
	sleep?: (delayMs: number) => Promise<void>;
};

type MutationHeaders = {
	"Idempotency-Key": string;
	"If-Match": string;
};

function fetchWithTimeout(request: Request, init?: RequestInit): Promise<Response> {
	const caller = init?.signal ?? request.signal;
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort();
	if (caller?.aborted) {
		controller.abort();
	} else {
		caller?.addEventListener("abort", onAbort, { once: true });
	}
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, REQUEST_TIMEOUT_MS);
	return fetch(request, { ...init, signal: controller.signal })
		.catch((cause: unknown) => {
			if (timedOut) throw new BillingNetworkError("timeout", { cause });
			if (caller?.aborted) throw cause;
			throw new BillingNetworkError("offline", { cause });
		})
		.finally(() => {
			clearTimeout(timeoutId);
			caller?.removeEventListener("abort", onAbort);
		});
}

export function unwrapDeploy<T>(result: DeployResult<T>): T {
	if (result.error !== undefined || !result.response.ok) {
		const detail =
			result.error === undefined ? result.response.statusText : extractApiDetail(result.error);
		throw new BillingApiError(result.response.status, detail, result.error);
	}
	return result.data as T;
}

function operationIdFromName(name: string): string {
	const prefix = "operations/";
	const operationId = name.startsWith(prefix) ? name.slice(prefix.length) : "";
	if (!operationId) {
		throw new BillingApiError(502, "The deployment service returned an invalid operation name.");
	}
	return operationId;
}

function deploymentIdFromOperation(operation: DeploymentOperation): string | null {
	return operation.response?.["@type"] ===
		"type.googleapis.com/clawdi.v2.DeploymentOperationResponse"
		? operation.response.deployment.id
		: null;
}

function strongResourceEtag(deployment: HostedDeployment): string {
	const resourceVersion = deployment.resource.metadata.resourceVersion;
	const valid =
		resourceVersion.length > 0 &&
		resourceVersion.length <= 128 &&
		Array.from(resourceVersion).every((character) => {
			const code = character.charCodeAt(0);
			return code >= 0x21 && code <= 0x7e && character !== '"' && character !== "\\";
		});
	if (!valid) {
		throw new BillingApiError(502, "The deployment service returned an invalid resource ETag.");
	}
	return `"${resourceVersion}"`;
}

function isPreconditionConflict(error: unknown): error is BillingApiError {
	return error instanceof BillingApiError && (error.status === 409 || error.status === 412);
}

function terminalDeployRequestError(status: HostedDeployRequestStatus): BillingApiError {
	return new BillingApiError(
		409,
		status.request_status === "superseded"
			? "This deployment request was superseded by a newer attempt."
			: "The deployment request could not be completed.",
		status,
	);
}

/**
 * Generated deploy-api client facade. Request/response bodies come from
 * `packages/shared/src/api/deploy.generated.ts`; this hook only centralizes
 * auth, timeout, and billing-specific error normalization.
 */
export function createBillingClient(
	getToken: BillingAuthTokenGetter,
	options: BillingClientOptions = {},
) {
	const api = createClient<DeployPaths>({
		baseUrl: ROOT_BASE_URL,
		fetch: options.fetch ?? fetchWithTimeout,
	});
	api.use({
		async onRequest({ request }) {
			const token = await getToken();
			if (token) request.headers.set("Authorization", `Bearer ${token}`);
			return request;
		},
	});

	const pollIntervalMs = options.operationPollIntervalMs ?? 1_000;
	const pollLimit = options.operationPollLimit ?? 120;
	const sleep =
		options.sleep ??
		((delayMs: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)));

	const getDeployment = async (id: string): Promise<HostedDeployment> =>
		unwrapDeploy(
			await api.GET("/v2/deployments/{deployment_id}", {
				params: { path: { deployment_id: id } },
			}),
		);

	const getOperation = async (operationId: string): Promise<DeploymentOperation> =>
		unwrapDeploy(
			await api.GET("/v2/operations/{operation_id}", {
				params: { path: { operation_id: operationId } },
			}),
		);

	const waitForOperation = async (
		initialOperation: DeploymentOperation,
	): Promise<DeploymentOperation> => {
		let operation = initialOperation;
		for (let poll = 0; poll <= pollLimit; poll += 1) {
			if (operation.done) {
				if (operation.error) {
					throw new BillingApiError(409, operation.error.message, operation.error);
				}
				return operation;
			}
			if (poll === pollLimit) break;
			await sleep(pollIntervalMs);
			operation = await getOperation(operationIdFromName(operation.name));
		}
		throw new BillingNetworkError("timeout");
	};

	const getDeploymentByRequest = async (
		deployRequestId: string,
	): Promise<HostedDeployRequestStatus> =>
		unwrapDeploy(
			await api.GET("/v2/deployments/by-request/{deploy_request_id}", {
				params: { path: { deploy_request_id: deployRequestId } },
			}),
		);

	const waitForDeploymentRequest = async (
		deployRequestId: string,
	): Promise<DeploymentIntentResult> => {
		for (let poll = 0; poll <= pollLimit; poll += 1) {
			const status = await getDeploymentByRequest(deployRequestId);
			if (
				status.request_status === "failed" ||
				status.request_status === "expired" ||
				status.request_status === "superseded"
			) {
				throw terminalDeployRequestError(status);
			}

			const projectedOperation = status.lineage_tail?.operation ?? null;
			const operationName = status.lineage_tail?.operation_name ?? null;
			if (projectedOperation || operationName) {
				const initialOperation =
					projectedOperation ?? (await getOperation(operationIdFromName(operationName ?? "")));
				const operation = await waitForOperation(initialOperation);
				const deploymentId =
					deploymentIdFromOperation(operation) ?? status.lineage_tail?.deployment_id ?? null;
				if (deploymentId) return { deploymentId, operation };
			}
			const deploymentId = status.lineage_tail?.deployment_id ?? null;
			if (status.request_status === "succeeded" && deploymentId) {
				return { deploymentId, operation: null };
			}
			if (poll === pollLimit) break;
			await sleep(pollIntervalMs);
		}
		throw new BillingNetworkError("timeout");
	};

	const acceptDeploymentMutation = async (
		id: string,
		idempotencyKey: string,
		send: (headers: MutationHeaders) => Promise<DeployResult<DeploymentOperation>>,
	): Promise<DeploymentOperation> => {
		let deployment = await getDeployment(id);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const headers: MutationHeaders = {
				"Idempotency-Key": idempotencyKey,
				"If-Match": strongResourceEtag(deployment),
			};
			let accepted: DeploymentOperation;
			try {
				accepted = unwrapDeploy(await send(headers));
			} catch (error) {
				if (!isPreconditionConflict(error)) throw error;
				if (attempt === 0) {
					deployment = await getDeployment(id);
					continue;
				}
				throw new DeploymentConflictError({ cause: error });
			}
			return waitForOperation(accepted);
		}
		throw new DeploymentConflictError();
	};

	return {
		getWallet: async () => unwrapDeploy(await api.GET("/v2/wallet")),
		getLedger: async (limit = 50) =>
			unwrapDeploy(
				await api.GET("/v2/wallet/ledger", {
					params: { query: { limit } },
				}),
			),
		topUp: async (body: WalletTopupRequest, idempotencyKey: string) =>
			unwrapDeploy(
				await api.POST("/v2/wallet/topup", {
					body,
					headers: { "Idempotency-Key": idempotencyKey },
				}),
			),
		setAutoReload: async (body: WalletAutoReloadRequest) =>
			unwrapDeploy(await api.PUT("/v2/wallet/auto-reload", { body })),

		getPlans: async () => unwrapDeploy(await api.GET("/v2/subscription/plans")),
		getBillingHistory: async (limit = 20, cursor?: string | null) =>
			unwrapDeploy(
				await api.GET("/v2/subscription/billing-history", {
					params: { query: { limit, cursor } },
				}),
			),
		checkout: async (body: CheckoutRequest, idempotencyKey: string) =>
			unwrapDeploy(
				await api.POST("/v2/subscription/checkout", {
					body,
					headers: { "Idempotency-Key": idempotencyKey },
				}),
			),
		quoteSubscription: async (body: ComputeSubscriptionQuoteRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/quote", { body })),
		quotePlanChange: async (body: ComputePlanChangeQuoteRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/plan/quote", { body })),
		changePlan: async (body: ComputePlanChangeRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/plan/change", { body })),
		cancelSubscription: async (body: ComputeSubscriptionCancelRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/cancel", { body })),
		fixPayment: async (body: ComputeFixPaymentRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/fix-payment", { body })),
		portal: async (body: PortalRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/portal", { body })),
		resumeSubscription: async (body: ComputeSubscriptionResumeRequest) =>
			unwrapDeploy(await api.POST("/v2/subscription/resume", { body })),
		getUsage: async () => unwrapDeploy(await api.GET("/v2/usage")),

		getMe: async () => unwrapDeploy(await api.GET("/v1/me")),
		getLegacyAgentEnvironments: async () => unwrapDeploy(await api.GET("/v1/agent-environments")),

		listDeployments: async (): Promise<HostedDeployment[]> =>
			unwrapDeploymentList(unwrapDeploy(await api.GET("/v2/deployments"))),
		listEventStreamHandoff: async (): Promise<HostedEventStreamSnapshotHandoff> =>
			unwrapDeploymentEventStreamSnapshotHandoff(
				unwrapDeploy(
					await api.GET("/v2/deployments", {
						params: { query: { eventStreamHandoff: true } },
					}),
				),
			),
		getDeployment,
		getDeploymentByRequest,
		getOperation,
		waitForDeploymentRequest,
		waitForOperation,
		createTerminalSession: async (id: string) =>
			unwrapDeploy(
				await api.POST("/v2/deployments/{deployment_id}/terminal", {
					params: { path: { deployment_id: id } },
				}),
			),
		getRuntimeUiCredentials: async (id: string) =>
			unwrapDeploy(
				await api.POST("/v2/deployments/{deployment_id}/runtime-ui/credentials", {
					params: { path: { deployment_id: id } },
				}),
			),
		setDeploymentDesiredState: async (
			id: string,
			desiredLifecycle: DeploymentDesiredLifecycle,
			idempotencyKey: string,
		) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				desiredLifecycle === "running"
					? api.POST("/v2/deployments/{deployment_id}/start", {
							params: { path: { deployment_id: id }, header: headers },
						})
					: api.POST("/v2/deployments/{deployment_id}/stop", {
							params: { path: { deployment_id: id }, header: headers },
						}),
			),
		restartDeployment: async (id: string, idempotencyKey: string) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				api.POST("/v2/deployments/{deployment_id}/restart", {
					params: { path: { deployment_id: id }, header: headers },
				}),
			),
		updateDeployment: async (id: string, body: DeploymentUpdateRequest, idempotencyKey: string) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				api.PATCH("/v2/deployments/{deployment_id}", {
					params: { path: { deployment_id: id }, header: headers },
					body,
				}),
			),
		deleteDeployment: async (id: string, idempotencyKey: string) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				api.DELETE("/v2/deployments/{deployment_id}", {
					params: { path: { deployment_id: id }, header: headers },
				}),
			),
	};
}

export function useBillingClient() {
	const { getToken } = useAuthToken();
	return useMemo(() => createBillingClient(getToken), [getToken]);
}

export type BillingClient = ReturnType<typeof useBillingClient>;
