"use client";

import { useMemo } from "react";
import { hostedApiBaseUrl, hostedV2ApiBaseUrl } from "@/hosted/billing/billing-url";
import type {
	ActivationFeeStatus,
	CheckoutRequest,
	CheckoutResult,
	DeployRequest,
	HostedDeployment,
	HostedUser,
	Plan,
	PortalRequest,
	PortalResult,
	Subscription,
	UsageSummary,
	WalletAutoReloadRequest,
	WalletLedgerPage,
	WalletState,
	WalletTopupRequest,
	WalletTopupResult,
} from "@/hosted/billing/contracts";
import { BillingApiError, BillingNetworkError } from "@/hosted/billing/errors";
import { isDeployApiConfigured } from "@/hosted/clawdi-api";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";

const BASE_URL = env.NEXT_PUBLIC_DEPLOY_API_URL;
const ROOT_BASE_URL = hostedApiBaseUrl(BASE_URL);
const V2_BASE_URL = hostedV2ApiBaseUrl(BASE_URL);

/**
 * Client-side request ceiling. A hung backend or a black-holed connection must
 * not leave a surface spinning forever — abort after this and surface a
 * recoverable `BillingNetworkError("timeout")` instead.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export { isDeployApiConfigured };

interface CallOptions {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	body?: unknown;
	query?: Record<string, string | number | undefined>;
	headers?: Record<string, string>;
}

function buildUrl(baseUrl: string, path: string, query?: CallOptions["query"]): string {
	const url = new URL(`${baseUrl}${path}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
}

/**
 * Cross-origin, Clerk-authenticated client for the hosted billing surfaces.
 *
 * Mirrors `useClawdiApi` (same backend, same JWT pattern) but with
 * hand-typed methods because the wallet/subscription paths aren't in the
 * generated `DeployPaths` allowlist. Every method throws `BillingApiError`
 * on a non-2xx so TanStack Query routes failures through its error path and
 * the surfaces can normalize the copy.
 */
export function useBillingClient() {
	const { getToken } = useAuthToken();
	return useMemo(() => {
		async function call<T>(
			path: string,
			opts: CallOptions = {},
			baseUrl = V2_BASE_URL,
		): Promise<T> {
			const token = await getToken();
			const headers: Record<string, string> = { ...opts.headers };
			if (token) headers.Authorization = `Bearer ${token}`;
			if (opts.body !== undefined) headers["Content-Type"] = "application/json";

			// Bound every request so a stalled connection can't freeze the UI.
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			let response: Response;
			try {
				response = await fetch(buildUrl(baseUrl, path, opts.query), {
					method: opts.method ?? "GET",
					headers,
					body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
					signal: controller.signal,
				});
			} catch (cause) {
				// fetch only rejects on transport failure (offline, DNS, CORS,
				// abort) — never on a non-2xx. Map our timeout abort and bare
				// network failures to a recoverable, normalizable error.
				if (controller.signal.aborted) throw new BillingNetworkError("timeout", { cause });
				throw new BillingNetworkError("offline", { cause });
			} finally {
				clearTimeout(timeout);
			}

			if (!response.ok) throw await BillingApiError.fromResponse(response);
			if (response.status === 204) return undefined as T;
			const text = await response.text();
			return (text ? JSON.parse(text) : undefined) as T;
		}

		return {
			// Wallet
			getWallet: () => call<WalletState>("/wallet"),
			getLedger: (limit = 50) => call<WalletLedgerPage>("/wallet/ledger", { query: { limit } }),
			topUp: (body: WalletTopupRequest, idempotencyKey: string) =>
				call<WalletTopupResult>("/wallet/topup", {
					method: "POST",
					body,
					// Collapse a timeout-retry / double-tab into one charge: a real
					// PaymentIntent must never be created twice.
					headers: { "Idempotency-Key": idempotencyKey },
				}),
			setAutoReload: (body: WalletAutoReloadRequest) =>
				call<WalletState>("/wallet/auto-reload", { method: "PUT", body }),

			// Subscription / compute
			getPlans: () => call<Plan[]>("/subscription/plans"),
			getSubscription: () => call<Subscription | null>("/subscription/current"),
			getActivationFee: () => call<ActivationFeeStatus>("/subscription/activation-fee"),
			checkout: (body: CheckoutRequest) =>
				call<CheckoutResult>("/subscription/checkout", { method: "POST", body }),
			portal: (body: PortalRequest) =>
				call<PortalResult>("/subscription/portal", { method: "POST", body }),
			// Usage
			getUsage: () => call<UsageSummary>("/usage"),

			// Identity is a shared cloud-api route, not under /v2.
			getMe: () => call<HostedUser>("/me", {}, ROOT_BASE_URL),

			// Deployments (hosted, with UI-exposure fields)
			listDeployments: () => call<HostedDeployment[]>("/deployments"),
			createDeployment: (body: DeployRequest) =>
				call<HostedDeployment>("/deployments", { method: "POST", body }),

			// Deployment manifest edits + lifecycle.
			// `setAgentEnabled` / `onboardAgent` / `setAgentAiProvider` / `rename`
			// update the hosted deployment without requiring the user to recreate it.
			setAgentEnabled: (id: string, agentType: string, enabled: boolean) =>
				call<HostedDeployment>(`/deployments/${id}/agents/${agentType}`, {
					method: "PATCH",
					body: { enabled },
				}),
			setAgentAiProvider: (id: string, agentType: string, body: Record<string, unknown>) =>
				call<HostedDeployment>(`/deployments/${id}/agents/${agentType}/ai-provider`, {
					method: "PATCH",
					body,
				}),
			renameDeployment: (id: string, name: string) =>
				call<HostedDeployment>(`/deployments/${id}`, {
					method: "PATCH",
					body: { assistant_name: name, name },
				}),
			onboardAgent: (id: string, body: Record<string, unknown>) =>
				call<HostedDeployment>(`/deployments/${id}/onboard-agent`, { method: "POST", body }),
			restartDeployment: (id: string) =>
				call<{ status: string }>(`/deployments/${id}/restart`, { method: "POST" }),
			stopDeployment: (id: string) =>
				call<{ status: string }>(`/deployments/${id}/stop`, { method: "POST" }),
			startDeployment: (id: string) =>
				call<{ status: string }>(`/deployments/${id}/start`, { method: "POST" }),
			deleteDeployment: (id: string) =>
				call<{ status: string }>(`/deployments/${id}`, { method: "DELETE" }),
		};
	}, [getToken]);
}

export type BillingClient = ReturnType<typeof useBillingClient>;
