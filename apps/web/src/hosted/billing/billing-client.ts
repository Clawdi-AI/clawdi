"use client";

import {
	type DeployPaths,
	extractApiDetail,
	isRuntimeUiCredentials,
	isRuntimeUiEndpointInfo,
	type RuntimeUiCredentials,
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
	DeploymentOperation,
	DeploymentUpdateRequest,
	DeployRequest,
	HostedDeployment,
	HostedDeploymentRead,
	HostedDeployRequestStatus,
	PortalRequest,
	WalletAutoReloadRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import { BillingApiError, BillingNetworkError, isRetryableError } from "@/hosted/billing/errors";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";
import { isDeployApiConfigured } from "@/lib/hosted-api";

const BASE_URL = env.VITE_CLAWDI_DEPLOY_API_URL;
const ROOT_BASE_URL = hostedApiBaseUrl(BASE_URL);

const REQUEST_TIMEOUT_MS = 20_000;

export { isDeployApiConfigured };

type DeployResult<T> = { data?: T; error?: unknown; response: Response };

type PollOptions = {
	intervalMs?: number;
	now?: () => number;
	sleep?: (delayMs: number) => Promise<void>;
	timeoutMs?: number;
};

const DEPLOYMENT_POLL_INTERVAL_MS = 1_000;
const DEPLOYMENT_POLL_TIMEOUT_MS = 120_000;

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

function sleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function deploymentFundingEvent(
	read: HostedDeploymentRead,
): HostedDeployment["last_funding_event"] {
	const fact = read.commercial_display?.latest_funding_fact;
	if (
		fact?.fact_kind !== "funding_revoked" ||
		!fact.funding_source ||
		!fact.reason ||
		!fact.prior_plan_slug ||
		fact.compute_subscription_id == null
	) {
		return null;
	}
	return {
		type: "compute_subscription_fallback",
		funding_source: fact.funding_source,
		reason: fact.reason,
		occurred_at: fact.occurred_at,
		prior_plan_slug: fact.prior_plan_slug,
		subscription_id: fact.compute_subscription_id,
	};
}

export function deploymentFromRead(read: HostedDeploymentRead): HostedDeployment {
	const { resource } = read;
	const { spec, status, metadata } = resource;
	const runtime = spec.runtime;
	const runtimeConfiguration = spec.runtime_configuration;
	const candidateEndpoint = isRuntimeUiEndpointInfo(read.runtime_ui_endpoint)
		? read.runtime_ui_endpoint
		: null;
	const endpoint = candidateEndpoint?.runtime === runtime ? candidateEndpoint : null;
	const runtimeUrl = endpoint?.url ?? null;
	const plan =
		read.current_plan_slug === "compute_basic" || read.current_plan_slug === "compute_performance"
			? read.current_plan_slug
			: null;
	if (!plan) throw new BillingApiError(502, "Deployment compute plan was invalid");
	const authKind = read.ai_provider_auth_kinds[runtime] ?? "unmanaged";
	const providerIds = runtimeConfiguration.providers.map((provider) => provider.provider_id);
	const primaryProviderId =
		runtimeConfiguration.primary_model?.provider_id ?? providerIds[0] ?? null;
	return {
		id: resource.id,
		user_id: resource.owner_user_id,
		deploy_request_id: resource.deploy_request_id,
		name: spec.name,
		app_id: resource.deployment_target,
		status: status.summary_state,
		failure_reason: status.failure?.detail ?? null,
		endpoints: status.endpoints.map((item) => item.url),
		native_url: runtimeUrl,
		openclaw_control_ui_url: runtime === "openclaw" ? runtimeUrl : null,
		hermes_control_ui_url: runtime === "hermes" ? runtimeUrl : null,
		config_info: {
			compute_plan_slug: plan,
			primary_model: runtimeConfiguration.primary_model ?? null,
			ai_provider_id: primaryProviderId,
			ai_provider_auth_kind: authKind,
			ai_provider_bindings: {
				[runtime]: {
					auth_kind: authKind,
					provider_id: primaryProviderId,
					provider_ids: providerIds,
					primary_model: runtimeConfiguration.primary_model ?? null,
				},
			},
			public_ports: spec.ports
				.filter((item) => item.visibility === "public")
				.map((item) => item.port),
			runtime,
			clawdi_cloud_environments: read.clawdi_cloud_environments ?? {},
			vcpu: spec.resources.vcpu,
			ram_gb: spec.resources.memory_mib / 1024,
			disk_gb: spec.resources.disk_gib,
			language: runtimeConfiguration.language ?? null,
			timezone: runtimeConfiguration.timezone ?? null,
		},
		compute_subscription: read.commercial_display?.compute_subscription ?? null,
		last_funding_event: deploymentFundingEvent(read),
		created_at: metadata.createdAt,
		upgrade_available: read.upgrade_available,
		resource_version: metadata.resourceVersion,
		runtime_ui_endpoint: endpoint,
	};
}

export function strongDeploymentEtag(resourceVersion: string): string {
	if (!/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(resourceVersion)) {
		throw new BillingApiError(502, "Deployment resource version was invalid");
	}
	return `"${resourceVersion}"`;
}

function validIdempotencyKey(value: string, maxLength: number): string {
	if (value.length > maxLength || !/^[\x21-\x7e]+$/.test(value)) {
		throw new BillingApiError(400, "Idempotency key was invalid");
	}
	return value;
}

export function deploymentMutationHeaders(
	deployment: Pick<HostedDeployment, "resource_version">,
	idempotencyKey: string,
): { "Idempotency-Key": string; "If-Match": string } {
	return {
		"Idempotency-Key": validIdempotencyKey(idempotencyKey, 255),
		"If-Match": strongDeploymentEtag(deployment.resource_version),
	};
}

export function operationId(operation: DeploymentOperation): string {
	const match = /^operations\/([A-Za-z0-9._~-]+)$/.exec(operation.name);
	if (!match?.[1]) throw new BillingApiError(502, "Deployment operation name was invalid");
	return match[1];
}

export function deployRequestIdFromContentLocation(value: string | null): string | null {
	if (value === null) return null;
	try {
		const location = new URL(value, "https://deploy.invalid");
		if (location.search || location.hash) {
			throw new Error("Deployment request status URL contained query or fragment data");
		}
		const marker = "/v2/deployments/by-request/";
		const markerIndex = location.pathname.lastIndexOf(marker);
		const encodedId = markerIndex < 0 ? "" : location.pathname.slice(markerIndex + marker.length);
		if (!encodedId || encodedId.includes("/")) {
			throw new Error("Deployment request status URL had no request id");
		}
		const deployRequestId = decodeURIComponent(encodedId);
		if (!deployRequestId.trim()) {
			throw new Error("Deployment request status URL had a blank request id");
		}
		return deployRequestId;
	} catch (cause) {
		throw new BillingApiError(502, "Deployment request status URL was invalid", cause);
	}
}

function operationErrorHttpStatus(code: number): number {
	switch (code) {
		case 3:
			return 400;
		case 5:
			return 404;
		case 6:
		case 9:
		case 10:
			return 409;
		case 7:
			return 403;
		case 8:
			return 429;
		case 16:
			return 401;
		case 4:
			return 504;
		case 14:
			return 503;
		default:
			return 500;
	}
}

function operationResult(operation: DeploymentOperation): DeploymentOperation {
	if (!operation.done) return operation;
	if (!operation.error) return operation;
	throw new BillingApiError(
		operationErrorHttpStatus(operation.error.code),
		operation.error.message,
		operation.error,
	);
}

function requireAcceptedDeploymentOperation(
	operation: DeploymentOperation,
	deploymentId: string,
	verb: DeploymentOperation["metadata"]["verb"],
): DeploymentOperation {
	const accepted = operationResult(operation);
	operationId(accepted);
	if (accepted.metadata.deploymentId !== deploymentId || accepted.metadata.verb !== verb) {
		throw new BillingApiError(502, "Deployment mutation returned the wrong operation");
	}
	return accepted;
}

export async function pollDeploymentOperation(
	initial: DeploymentOperation,
	readOperation: (id: string) => Promise<DeploymentOperation>,
	options: PollOptions = {},
): Promise<DeploymentOperation> {
	let operation = operationResult(initial);
	if (operation.done) return operation;
	const now = options.now ?? Date.now;
	const wait = options.sleep ?? sleep;
	const intervalMs = options.intervalMs ?? DEPLOYMENT_POLL_INTERVAL_MS;
	const deadline = now() + (options.timeoutMs ?? DEPLOYMENT_POLL_TIMEOUT_MS);
	const id = operationId(operation);
	const expectedName = operation.name;
	const expectedDeploymentId = operation.metadata.deploymentId;
	const expectedVerb = operation.metadata.verb;
	while (now() < deadline) {
		await wait(intervalMs);
		let next: DeploymentOperation;
		try {
			next = await readOperation(id);
		} catch (error) {
			if (!isRetryableError(error)) throw error;
			continue;
		}
		if (
			next.name !== expectedName ||
			next.metadata.deploymentId !== expectedDeploymentId ||
			next.metadata.verb !== expectedVerb
		) {
			throw new BillingApiError(502, "Deployment operation identity changed while polling");
		}
		operation = operationResult(next);
		if (operation.done) return operation;
	}
	throw new BillingNetworkError("timeout");
}

function deployRequestFailure(status: HostedDeployRequestStatus): BillingApiError {
	return new BillingApiError(
		409,
		`Deployment request ${status.request_status}`,
		status.lineage_tail?.termination_reason ?? status,
	);
}

export async function pollDeploymentRequest(
	initial: HostedDeployRequestStatus,
	readRequest: (id: string) => Promise<HostedDeployRequestStatus>,
	options: PollOptions = {},
): Promise<string> {
	let status = initial;
	const expectedDeployRequestId = initial.deploy_request_id;
	const now = options.now ?? Date.now;
	const wait = options.sleep ?? sleep;
	const intervalMs = options.intervalMs ?? DEPLOYMENT_POLL_INTERVAL_MS;
	const deadline = now() + (options.timeoutMs ?? DEPLOYMENT_POLL_TIMEOUT_MS);
	while (true) {
		const deploymentId = status.lineage_tail?.deployment_id;
		if (deploymentId) return deploymentId;
		if (status.request_status === "succeeded") {
			throw new BillingApiError(502, "Deployment request completed without a deployment id");
		}
		if (["failed", "expired", "superseded"].includes(status.request_status)) {
			throw deployRequestFailure(status);
		}
		if (now() >= deadline) throw new BillingNetworkError("timeout");
		await wait(intervalMs);
		let next: HostedDeployRequestStatus;
		try {
			next = await readRequest(expectedDeployRequestId);
		} catch (error) {
			if (!isRetryableError(error)) throw error;
			continue;
		}
		if (next.deploy_request_id !== expectedDeployRequestId) {
			throw new BillingApiError(502, "Deployment request status changed request identity");
		}
		status = next;
	}
}

/**
 * Generated deploy-api client facade. Request/response bodies come from
 * `packages/shared/src/api/deploy.generated.ts`; this hook only centralizes
 * auth, timeout, and billing-specific error normalization.
 */
export function useBillingClient() {
	const { getToken } = useAuthToken();
	return useMemo(() => {
		const api = createClient<DeployPaths>({
			baseUrl: ROOT_BASE_URL,
			fetch: fetchWithTimeout,
		});
		api.use({
			async onRequest({ request }) {
				const token = await getToken();
				if (token) request.headers.set("Authorization", `Bearer ${token}`);
				return request;
			},
		});

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

			listDeployments: async (): Promise<HostedDeployment[]> => {
				const deployments = unwrapDeploy(await api.GET("/v2/deployments"));
				if (!Array.isArray(deployments)) return [];
				return deployments.map(deploymentFromRead);
			},
			getDeploymentByRequest: async (deployRequestId: string) =>
				unwrapDeploy(
					await api.GET("/v2/deployments/by-request/{deploy_request_id}", {
						params: { path: { deploy_request_id: deployRequestId } },
					}),
				),
			createDeployment: async (body: DeployRequest, idempotencyKey: string) => {
				const result = await api.POST("/v2/deployments", {
					body,
					params: {
						header: { "Idempotency-Key": validIdempotencyKey(idempotencyKey, 191) },
					},
				});
				const accepted = operationResult(unwrapDeploy(result));
				operationId(accepted);
				if (accepted.metadata.verb !== "create") {
					throw new BillingApiError(502, "Deployment creation returned the wrong operation kind");
				}
				const deployRequestId = deployRequestIdFromContentLocation(
					result.response.headers.get("Content-Location"),
				);
				if (!deployRequestId) return accepted.metadata.deploymentId;
				const deploymentId = await pollDeploymentRequest(
					{ deploy_request_id: deployRequestId, request_status: "pending" },
					async (requestId) =>
						unwrapDeploy(
							await api.GET("/v2/deployments/by-request/{deploy_request_id}", {
								params: { path: { deploy_request_id: requestId } },
							}),
						),
				);
				if (deploymentId !== accepted.metadata.deploymentId) {
					throw new BillingApiError(502, "Deployment creation lineage did not match its operation");
				}
				return deploymentId;
			},

			updateDeployment: async (
				deployment: HostedDeployment,
				body: DeploymentUpdateRequest,
				idempotencyKey: string,
			) => {
				const headers = deploymentMutationHeaders(deployment, idempotencyKey);
				const accepted = requireAcceptedDeploymentOperation(
					unwrapDeploy(
						await api.PATCH("/v2/deployments/{deployment_id}", {
							params: { path: { deployment_id: deployment.id }, header: headers },
							body,
						}),
					),
					deployment.id,
					"update",
				);
				return pollDeploymentOperation(accepted, async (id) =>
					unwrapDeploy(
						await api.GET("/v2/operations/{operation_id}", {
							params: { path: { operation_id: id } },
						}),
					),
				);
			},
			createTerminalSession: async (id: string) =>
				unwrapDeploy(
					await api.POST("/v2/deployments/{deployment_id}/terminal", {
						params: { path: { deployment_id: id } },
					}),
				),
			getRuntimeUiCredentials: async (id: string): Promise<RuntimeUiCredentials> => {
				const credentials = unwrapDeploy(
					await api.POST("/v2/deployments/{deployment_id}/runtime-ui/credentials", {
						params: { path: { deployment_id: id } },
					}),
				);
				if (!isRuntimeUiCredentials(credentials)) {
					throw new BillingApiError(502, "Runtime UI credential response was invalid");
				}
				return credentials;
			},
			restartDeployment: async (deployment: HostedDeployment, idempotencyKey: string) => {
				const headers = deploymentMutationHeaders(deployment, idempotencyKey);
				const accepted = requireAcceptedDeploymentOperation(
					unwrapDeploy(
						await api.POST("/v2/deployments/{deployment_id}/restart", {
							params: { path: { deployment_id: deployment.id }, header: headers },
						}),
					),
					deployment.id,
					"restart",
				);
				return pollDeploymentOperation(accepted, async (id) =>
					unwrapDeploy(
						await api.GET("/v2/operations/{operation_id}", {
							params: { path: { operation_id: id } },
						}),
					),
				);
			},
			stopDeployment: async (deployment: HostedDeployment, idempotencyKey: string) => {
				const headers = deploymentMutationHeaders(deployment, idempotencyKey);
				const accepted = requireAcceptedDeploymentOperation(
					unwrapDeploy(
						await api.POST("/v2/deployments/{deployment_id}/stop", {
							params: { path: { deployment_id: deployment.id }, header: headers },
						}),
					),
					deployment.id,
					"stop",
				);
				return pollDeploymentOperation(accepted, async (id) =>
					unwrapDeploy(
						await api.GET("/v2/operations/{operation_id}", {
							params: { path: { operation_id: id } },
						}),
					),
				);
			},
			startDeployment: async (deployment: HostedDeployment, idempotencyKey: string) => {
				const headers = deploymentMutationHeaders(deployment, idempotencyKey);
				const accepted = requireAcceptedDeploymentOperation(
					unwrapDeploy(
						await api.POST("/v2/deployments/{deployment_id}/start", {
							params: { path: { deployment_id: deployment.id }, header: headers },
						}),
					),
					deployment.id,
					"start",
				);
				return pollDeploymentOperation(accepted, async (id) =>
					unwrapDeploy(
						await api.GET("/v2/operations/{operation_id}", {
							params: { path: { operation_id: id } },
						}),
					),
				);
			},
			deleteDeployment: async (deployment: HostedDeployment, idempotencyKey: string) => {
				const headers = deploymentMutationHeaders(deployment, idempotencyKey);
				const accepted = requireAcceptedDeploymentOperation(
					unwrapDeploy(
						await api.DELETE("/v2/deployments/{deployment_id}", {
							params: { path: { deployment_id: deployment.id }, header: headers },
						}),
					),
					deployment.id,
					"delete",
				);
				return pollDeploymentOperation(accepted, async (id) =>
					unwrapDeploy(
						await api.GET("/v2/operations/{operation_id}", {
							params: { path: { operation_id: id } },
						}),
					),
				);
			},
		};
	}, [getToken]);
}

export type BillingClient = ReturnType<typeof useBillingClient>;
