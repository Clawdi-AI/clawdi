"use client";

import { projectUserSelectableAiProviders } from "@clawdi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import { billingQueryRetry, normalizeBillingError } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";
import type {
	AiProviderAcceptRequest,
	AiProviderAcceptResponse,
	AiProviderConnectionTestRequest,
	AiProviderConnectionTestResponse,
	AiProviderList,
	AiProviderOAuthDevicePollResponse,
	AiProviderOAuthDeviceStartResponse,
} from "@/hosted/v2/ai-providers/types";
import { toastApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

/** Typed data hooks for the AI Providers surface (cloud-api `/v1/ai-providers`). */

const KEY = ["get", "/v1/ai-providers"] as const;
export const selectUserAiProviders = (data: AiProviderList) =>
	projectUserSelectableAiProviders(data.providers);

export function useAiProviders() {
	return useOpenApi().useQuery("get", "/v1/ai-providers", {});
}

export function useUserAiProviders({ enabled = true }: { enabled?: boolean } = {}) {
	return useOpenApi().useQuery(
		"get",
		"/v1/ai-providers",
		{},
		{
			select: selectUserAiProviders,
			enabled,
		},
	);
}

export function useAcceptProvider() {
	const api = useApi();
	const qc = useQueryClient();
	return useSensitiveAction(
		async ({
			body,
			idempotencyKey,
		}: {
			body: AiProviderAcceptRequest;
			idempotencyKey: string;
		}): Promise<AiProviderAcceptResponse> => {
			try {
				const result = unwrap(
					await api.POST("/v1/ai-providers/accept", {
						params: { header: { "Idempotency-Key": idempotencyKey } },
						body,
					}),
				);
				void qc.invalidateQueries({ queryKey: KEY });
				return result;
			} catch (error) {
				toastApiError("Couldn't save provider")(error);
				throw error;
			}
		},
	);
}

export function usePatchProvider() {
	const api = useOpenApi();
	const qc = useQueryClient();
	return api.useMutation("patch", "/v1/ai-providers/{provider_id}", {
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
		onError: toastApiError("Couldn't update provider"),
	});
}

export function useDeleteProvider() {
	const client = useBillingClient();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			providerId,
			impactRevision,
			providerIncarnationToken,
			idempotencyKey,
		}: {
			providerId: string;
			impactRevision: string;
			providerIncarnationToken: string;
			idempotencyKey: string;
		}) =>
			client.removeAiProvider(providerId, impactRevision, providerIncarnationToken, idempotencyKey),
		onSuccess: (result) => {
			void Promise.all([
				qc.invalidateQueries({ queryKey: KEY }),
				qc.invalidateQueries({ queryKey: billingKeys.deployments }),
			]);
			toast.success("Provider removed", {
				description:
					result.remote_revoke_status === "pending"
						? "Local access is removed immediately. Upstream ChatGPT revocation will finish asynchronously."
						: "Local access is removed immediately.",
			});
		},
		onError: (error) => {
			toast.error("Couldn't remove provider", {
				description: normalizeBillingError(error),
			});
		},
	});
}

export function useProviderRemovalImpact(providerId: string, enabled: boolean) {
	const client = useBillingClient();
	return useQuery({
		queryKey: ["hosted-ai-provider-removal-impact", providerId],
		queryFn: () => client.getAiProviderRemovalImpact(providerId),
		enabled: enabled && isDeployApiConfigured(),
		retry: billingQueryRetry,
	});
}

export function useTestDraftProviderConnection() {
	const api = useApi();
	return useSensitiveAction(
		async (body: AiProviderConnectionTestRequest): Promise<AiProviderConnectionTestResponse> => {
			try {
				return unwrap(await api.POST("/v1/ai-providers/test", { body }));
			} catch (error) {
				toastApiError("Couldn't test connection")(error);
				throw error;
			}
		},
	);
}

export function useTestProviderConnection() {
	return useOpenApi().useMutation("post", "/v1/ai-providers/{provider_id}/test", {
		onError: toastApiError("Couldn't test connection"),
	});
}

export function useOAuthDeviceStart() {
	const api = useApi();
	return useSensitiveAction(
		async (vars: {
			providerId: string;
			provider: string;
		}): Promise<AiProviderOAuthDeviceStartResponse> => {
			try {
				return unwrap(
					await api.POST("/v1/ai-providers/{provider_id}/auth/oauth/device/start", {
						params: { path: { provider_id: vars.providerId } },
						body: { provider: vars.provider },
					}),
				);
			} catch (error) {
				toastApiError("Couldn't start ChatGPT sign-in")(error);
				throw error;
			}
		},
	);
}

export function useOAuthDevicePoll() {
	const api = useApi();
	const qc = useQueryClient();
	return useSensitiveAction(
		async (vars: {
			providerId: string;
			state: string;
		}): Promise<AiProviderOAuthDevicePollResponse> => {
			const result = unwrap(
				await api.POST("/v1/ai-providers/{provider_id}/auth/oauth/device/poll", {
					params: { path: { provider_id: vars.providerId } },
					body: { state: vars.state },
				}),
			);
			if (result.status === "ready") void qc.invalidateQueries({ queryKey: KEY });
			return result;
		},
	);
}
