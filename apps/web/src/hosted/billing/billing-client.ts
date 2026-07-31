"use client";

import {
	type DeployPaths,
	extractApiDetail,
	projectHostedDeployRequest,
	projectManagedModelCatalog,
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
	ComputePlanChangeResult,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionQuoteRequest,
	ComputeSubscriptionResumeRequest,
	DeploymentCreateRequest,
	DeploymentDeleteRequest,
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
	DeploymentRequestTerminalError,
	PlanChangePendingError,
	PlanChangeTerminalError,
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

export type AcceptedOperation = { deploymentId: string; operation: DeploymentOperation };

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
		throw new BillingApiError(502, "The agent service returned an invalid operation name.");
	}
	return operationId;
}

function deploymentIdFromOperation(operation: DeploymentOperation): string | null {
	const metadataId = operation.metadata?.deploymentId?.trim();
	if (metadataId) return metadataId;
	return operation.response?.["@type"] ===
		"type.googleapis.com/clawdi.v2.DeploymentOperationResponse"
		? operation.response.deployment.id.trim() || null
		: null;
}

export function acceptDeclarativeOperation<T extends DeploymentOperation | null>(
	acceptance: {
		operation: T;
		deploymentId?: string | null;
	},
	missingDeploymentMessage = "The agent service completed creation without returning the agent.",
): {
	deploymentId: string;
	operation: T;
} {
	const deploymentId =
		(acceptance.operation ? deploymentIdFromOperation(acceptance.operation) : null) ||
		acceptance.deploymentId?.trim() ||
		null;
	if (!deploymentId) throw new BillingApiError(502, missingDeploymentMessage);
	return { deploymentId, operation: acceptance.operation };
}

function strongResourceEtag(resourceVersion: string): string {
	const valid =
		resourceVersion.length > 0 &&
		resourceVersion.length <= 128 &&
		Array.from(resourceVersion).every((character) => {
			const code = character.charCodeAt(0);
			return code >= 0x21 && code <= 0x7e && character !== '"' && character !== "\\";
		});
	if (!valid) {
		throw new BillingApiError(502, "The agent service returned an invalid resource version.");
	}
	return `"${resourceVersion}"`;
}

function isPreconditionConflict(error: unknown): error is BillingApiError {
	return error instanceof BillingApiError && (error.status === 409 || error.status === 412);
}

function terminalDeployRequestError(status: HostedDeployRequestStatus): BillingApiError {
	return new DeploymentRequestTerminalError(
		409,
		status.request_status === "superseded"
			? "This agent creation was superseded by a newer attempt."
			: "The agent could not be created.",
		status,
	);
}

type ParsedPlanChangeOperation = {
	name: string;
	done: boolean;
	state: string;
	effectiveAt: string;
	error: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function invalidPlanChangeResponse(): BillingApiError {
	return new BillingApiError(
		502,
		"We couldn't verify the plan change status. Check again in a moment.",
	);
}

function parsePlanChangeOperation(value: unknown): ParsedPlanChangeOperation {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.done !== "boolean") {
		throw invalidPlanChangeResponse();
	}
	const metadata = value.metadata;
	if (!isRecord(metadata) || metadata.verb !== "plan_change") {
		throw invalidPlanChangeResponse();
	}
	const progress = metadata.planChange;
	if (
		!isRecord(progress) ||
		typeof progress.state !== "string" ||
		typeof progress.effectiveAt !== "string"
	) {
		throw invalidPlanChangeResponse();
	}
	operationIdFromName(value.name);
	return {
		name: value.name,
		done: value.done,
		state: progress.state,
		effectiveAt: progress.effectiveAt,
		error: value.error,
	};
}

function planChangeTerminalError(error: unknown): BillingApiError {
	if (isRecord(error) && Array.isArray(error.details)) {
		const detail = error.details.find(
			(item) =>
				isRecord(item) && typeof item.status === "number" && typeof item.detail === "string",
		);
		if (
			isRecord(detail) &&
			typeof detail.status === "number" &&
			typeof detail.detail === "string"
		) {
			return new PlanChangeTerminalError(detail.status, detail.detail, { detail });
		}
	}
	return new PlanChangeTerminalError(
		409,
		"The plan change could not be completed. Review the price and try again.",
	);
}

function completedPlanChange(operation: ParsedPlanChangeOperation): ComputePlanChangeResult | null {
	if (!operation.done) {
		if (operation.error !== undefined && operation.error !== null) {
			throw invalidPlanChangeResponse();
		}
		return null;
	}
	if (operation.error !== undefined && operation.error !== null) {
		throw planChangeTerminalError(operation.error);
	}
	if (operation.state === "complete" || operation.state === "scheduled") {
		return { kind: operation.state, effectiveAt: operation.effectiveAt };
	}
	throw invalidPlanChangeResponse();
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

	const waitForPlanChange = async (
		initial: unknown,
		expectedOperationId: string,
		onAccepted?: (operationName: string) => void,
	): Promise<ComputePlanChangeResult> => {
		let operation = parsePlanChangeOperation(initial);
		if (operationIdFromName(operation.name) !== expectedOperationId) {
			throw invalidPlanChangeResponse();
		}
		onAccepted?.(operation.name);
		for (let poll = 0; poll <= pollLimit; poll += 1) {
			const completed = completedPlanChange(operation);
			if (completed) return completed;
			if (poll === pollLimit) throw new PlanChangePendingError(operation.name);
			await sleep(pollIntervalMs);
			operation = parsePlanChangeOperation(await getOperation(operationIdFromName(operation.name)));
		}
		throw new PlanChangePendingError(operation.name);
	};

	const getDeploymentByRequest = async (
		deployRequestId: string,
	): Promise<HostedDeployRequestStatus> =>
		unwrapDeploy(
			await api.GET("/v2/deployments/by-request/{deploy_request_id}", {
				params: { path: { deploy_request_id: deployRequestId } },
			}),
		);

	const waitForDeploymentRequest = async (deployRequestId: string) => {
		for (let poll = 0; poll <= pollLimit; poll += 1) {
			const status = await getDeploymentByRequest(deployRequestId);
			const projection = projectHostedDeployRequest(status);
			if (projection.kind === "terminal") {
				throw terminalDeployRequestError(status);
			}
			if (projection.kind === "operation") {
				return acceptDeclarativeOperation({
					operation: projection.operation,
					deploymentId: projection.deploymentId,
				});
			}
			if (projection.kind === "operation_name") {
				return acceptDeclarativeOperation({
					operation: await getOperation(operationIdFromName(projection.operationName)),
					deploymentId: projection.deploymentId,
				});
			}
			if (projection.kind === "deployment") {
				return acceptDeclarativeOperation({
					deploymentId: projection.deploymentId,
					operation: null,
				});
			}
			if (projection.kind === "invalid_success") {
				return acceptDeclarativeOperation({ deploymentId: null, operation: null });
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
	): Promise<AcceptedOperation> => {
		let deployment = await getDeployment(id);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const headers: MutationHeaders = {
				"Idempotency-Key": idempotencyKey,
				"If-Match": strongResourceEtag(deployment.resource.metadata.resourceVersion),
			};
			try {
				return acceptDeclarativeOperation({ operation: unwrapDeploy(await send(headers)) });
			} catch (error) {
				if (!isPreconditionConflict(error)) throw error;
				if (attempt === 0) {
					deployment = await getDeployment(id);
					continue;
				}
				throw new DeploymentConflictError({ cause: error });
			}
		}
		throw new DeploymentConflictError();
	};

	return {
		getManagedModelCatalog: async () =>
			projectManagedModelCatalog(unwrapDeploy(await api.GET("/v2/ai-providers/managed/models"))),
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
					params: { header: { "Idempotency-Key": idempotencyKey } },
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
		changePlan: async (
			body: ComputePlanChangeRequest,
			onAccepted?: (operationName: string) => void,
		): Promise<ComputePlanChangeResult> => {
			const response = unwrapDeploy(
				await api.POST("/v2/subscription/plan/change", {
					headers: { "Idempotency-Key": body.operation_id },
					body,
				}),
			);
			return waitForPlanChange(response, body.operation_id, onAccepted);
		},
		checkPlanChange: async (operationName: string) =>
			getOperation(operationIdFromName(operationName)).then((value) => {
				const operation = parsePlanChangeOperation(value);
				if (operation.name !== operationName) throw invalidPlanChangeResponse();
				const completed = completedPlanChange(operation);
				if (completed) return completed;
				throw new PlanChangePendingError(operation.name);
			}),
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
		waitForDeploymentRequest,
		createDeployment: async (
			body: DeploymentCreateRequest,
			idempotencyKey: string,
		): Promise<AcceptedOperation> =>
			acceptDeclarativeOperation({
				operation: unwrapDeploy(
					await api.POST("/v2/deployments", {
						params: { header: { "Idempotency-Key": idempotencyKey } },
						body,
					}),
				),
			}),
		createTerminalSession: async (id: string) =>
			unwrapDeploy(
				await api.POST("/v2/deployments/{deployment_id}/terminal", {
					params: { path: { deployment_id: id } },
				}),
			),
		getRuntimeUiCredentials: async (id: string, resourceVersion: string) =>
			unwrapDeploy(
				await api.POST("/v2/deployments/{deployment_id}/runtime-ui/credentials", {
					params: {
						path: { deployment_id: id },
						header: { "If-Match": strongResourceEtag(resourceVersion) },
					},
				}),
			),
		resetRuntimeUiAccess: async (id: string, idempotencyKey: string) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				api.POST("/v2/deployments/{deployment_id}/runtime-ui/access/reset", {
					params: { path: { deployment_id: id }, header: headers },
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
		deleteDeployment: async (id: string, body: DeploymentDeleteRequest, idempotencyKey: string) =>
			acceptDeploymentMutation(id, idempotencyKey, (headers) =>
				api.DELETE("/v2/deployments/{deployment_id}", {
					params: { path: { deployment_id: id }, header: headers },
					body,
				}),
			),
	};
}

export function useBillingClient() {
	const { getToken } = useAuthToken();
	return useMemo(() => createBillingClient(getToken), [getToken]);
}
