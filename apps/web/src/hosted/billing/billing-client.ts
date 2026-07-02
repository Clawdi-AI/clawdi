"use client";

import { type DeployPaths, extractApiDetail } from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { useMemo } from "react";
import { hostedApiBaseUrl } from "@/hosted/billing/billing-url";
import type {
	CheckoutRequest,
	ComputeSubscriptionCancelRequest,
	ComputeSubscriptionResumeRequest,
	DeployRequest,
	PortalRequest,
	WalletAutoReloadRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import { BillingApiError, BillingNetworkError } from "@/hosted/billing/errors";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";
import { isDeployApiConfigured } from "@/lib/hosted-api";

const BASE_URL = env.VITE_CLAWDI_DEPLOY_API_URL;
const ROOT_BASE_URL = hostedApiBaseUrl(BASE_URL);

const REQUEST_TIMEOUT_MS = 20_000;

export { isDeployApiConfigured };

type DeployResult<T> = { data?: T; error?: unknown; response: Response };
type RebindAgentAiProviderRequest =
	DeployPaths["/v2/deployments/{deployment_id}/agent-targets/{agent_id}/ai-provider"]["patch"]["requestBody"]["content"]["application/json"];

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
		throw new BillingApiError(result.response.status, detail);
	}
	return result.data as T;
}

/**
 * Generated deploy-api client facade. Request/response bodies come from
 * `packages/shared/src/api/deploy.generated.ts`; this hook only centralizes
 * auth, timeout, and billing-specific error normalization.
 */
export function useBillingClient() {
	const { getToken } = useAuthToken();
	return useMemo(() => {
		const api = createClient<DeployPaths>({ baseUrl: ROOT_BASE_URL, fetch: fetchWithTimeout });
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
			checkout: async (body: CheckoutRequest) =>
				unwrapDeploy(await api.POST("/v2/subscription/checkout", { body })),
			cancelSubscription: async (body: ComputeSubscriptionCancelRequest) =>
				unwrapDeploy(await api.POST("/v2/subscription/cancel", { body })),
			portal: async (body: PortalRequest) =>
				unwrapDeploy(await api.POST("/v2/subscription/portal", { body })),
			resumeSubscription: async (body: ComputeSubscriptionResumeRequest) =>
				unwrapDeploy(await api.POST("/v2/subscription/resume", { body })),
			getUsage: async () => unwrapDeploy(await api.GET("/v2/usage")),

			getMe: async () => unwrapDeploy(await api.GET("/me")),

			listDeployments: async () => unwrapDeploy(await api.GET("/v2/deployments")),
			createDeployment: async (body: DeployRequest) =>
				unwrapDeploy(await api.POST("/v2/deployments", { body })),

			setAgentEnabled: async (id: string, agentId: string, enabled: boolean) =>
				unwrapDeploy(
					await api.PATCH("/v2/deployments/{deployment_id}/agent-targets/{agent_id}", {
						params: {
							path: { deployment_id: id, agent_id: agentId },
						},
						body: { enabled },
					}),
				),
			setAgentAiProvider: async (id: string, agentId: string, body: RebindAgentAiProviderRequest) =>
				unwrapDeploy(
					await api.PATCH("/v2/deployments/{deployment_id}/agent-targets/{agent_id}/ai-provider", {
						params: {
							path: { deployment_id: id, agent_id: agentId },
						},
						body,
					}),
				),
			createTerminalSession: async (id: string, agentId: string) =>
				unwrapDeploy(
					await api.POST("/v2/deployments/{deployment_id}/terminal", {
						params: { path: { deployment_id: id } },
						body: { agent_id: agentId },
					}),
				),
			restartDeployment: async (id: string) =>
				unwrapDeploy(
					await api.POST("/v2/deployments/{deployment_id}/restart", {
						params: { path: { deployment_id: id } },
					}),
				),
			stopDeployment: async (id: string) =>
				unwrapDeploy(
					await api.POST("/v2/deployments/{deployment_id}/stop", {
						params: { path: { deployment_id: id } },
					}),
				),
			startDeployment: async (id: string) =>
				unwrapDeploy(
					await api.POST("/v2/deployments/{deployment_id}/start", {
						params: { path: { deployment_id: id } },
					}),
				),
			deleteDeployment: async (id: string) =>
				unwrapDeploy(
					await api.DELETE("/v2/deployments/{deployment_id}", {
						params: { path: { deployment_id: id } },
					}),
				),
		};
	}, [getToken]);
}

export type BillingClient = ReturnType<typeof useBillingClient>;
