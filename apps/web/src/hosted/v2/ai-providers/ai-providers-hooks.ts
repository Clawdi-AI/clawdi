"use client";

import { projectUserSelectableAiProviders } from "@clawdi/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
	AiProviderAcceptRequest,
	AiProviderAcceptResponse,
	AiProviderList,
	AiProviderPatch,
	AiProviderReadyAcceptResponse,
	AiProviderUpsert,
} from "@/hosted/v2/ai-providers/types";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

/** Typed data hooks for the AI Providers surface (cloud-api `/v1/ai-providers`). */

const KEY = ["ai-providers"] as const;
export const selectUserAiProviders = (data: AiProviderList) =>
	projectUserSelectableAiProviders(data.providers);

function aiProvidersQueryOptions(api: ReturnType<typeof useApi>) {
	return queryOptions({
		queryKey: KEY,
		queryFn: async () => unwrap(await api.GET("/v1/ai-providers")),
	});
}

export function useAiProviders() {
	return useQuery(aiProvidersQueryOptions(useApi()));
}

export function useUserAiProviders() {
	return useQuery({
		...aiProvidersQueryOptions(useApi()),
		select: selectUserAiProviders,
	});
}

export function useCreateProvider() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (body: AiProviderUpsert) =>
			unwrap(await api.POST("/v1/ai-providers", { body, params: { query: { replace: false } } })),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: KEY });
		},
		onError: toastApiError("Couldn't add provider"),
	});
}

export function useAcceptProvider() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({
			body,
			idempotencyKey,
		}: {
			body: AiProviderAcceptRequest;
			idempotencyKey: string;
		}): Promise<AiProviderAcceptResponse> =>
			unwrap(
				await api.POST("/v1/ai-providers/accept", {
					params: { header: { "Idempotency-Key": idempotencyKey } },
					body,
				}),
			),
		onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
		onError: toastApiError("Couldn't add provider"),
	});
}

export function usePatchProvider() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (vars: { providerId: string; body: AiProviderPatch }) =>
			unwrap(
				await api.PATCH("/v1/ai-providers/{provider_id}", {
					params: { path: { provider_id: vars.providerId } },
					body: vars.body,
				}),
			),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
		onError: toastApiError("Couldn't update provider"),
	});
}

export function useDeleteProvider() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (providerId: string) =>
			unwrap(
				await api.DELETE("/v1/ai-providers/{provider_id}", {
					params: { path: { provider_id: providerId } },
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: KEY });
			toast.success("Provider removed");
		},
		onError: toastApiError("Couldn't remove provider"),
	});
}

/**
 * Codex pre-create that does NOT touch the cached provider list. The OAuth
 * `start` route needs the provider record to exist, but until `complete`
 * succeeds it isn't really connected — invalidating the list here would surface
 * a provider that looks connected even if the user abandons sign-in. The list
 * refreshes on a successful `complete` (`useOAuthComplete`) instead.
 */
export function useCreateProviderQuiet() {
	const api = useApi();
	return useMutation({
		mutationFn: async (body: AiProviderUpsert) =>
			unwrap(await api.POST("/v1/ai-providers", { body, params: { query: { replace: false } } })),
		onError: toastApiError("Couldn't start sign-in"),
	});
}

/** Silent provider delete (no toast) — cleans up an abandoned Codex pre-create. */
export function useDeleteProviderQuiet() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (providerId: string) =>
			unwrap(
				await api.DELETE("/v1/ai-providers/{provider_id}", {
					params: { path: { provider_id: providerId } },
				}),
			),
		onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
	});
}

export function useSetApiKey() {
	const api = useApi();
	const qc = useQueryClient();
	return useSensitiveAction(
		async (vars: { providerId: string; value: string; runtime_env_name?: string }) => {
			try {
				const result = unwrap(
					await api.POST("/v1/ai-providers/{provider_id}/auth/api-key", {
						params: { path: { provider_id: vars.providerId } },
						body: { value: vars.value, runtime_env_name: vars.runtime_env_name },
					}),
				);
				qc.invalidateQueries({ queryKey: KEY });
				return result;
			} catch (error) {
				toastApiError("Couldn't save API key")(error);
				throw error;
			}
		},
	);
}

export function useTestProviderConnection() {
	const api = useApi();
	return useMutation({
		mutationFn: async ({ providerId, model }: { providerId: string; model?: string }) =>
			unwrap(
				await api.POST("/v1/ai-providers/{provider_id}/test-connection", {
					params: { path: { provider_id: providerId } },
					body: model ? { model } : {},
				}),
			),
		onError: toastApiError("Couldn't test connection"),
	});
}

export function useOAuthStart() {
	const api = useApi();
	return useSensitiveAction(
		async (vars: { providerId: string; provider: string; redirect_uri?: string }) => {
			try {
				return unwrap(
					await api.POST("/v1/ai-providers/{provider_id}/auth/oauth/start", {
						params: { path: { provider_id: vars.providerId } },
						body: { provider: vars.provider, redirect_uri: vars.redirect_uri },
					}),
				);
			} catch (error) {
				toastApiError("Couldn't start sign-in")(error);
				throw error;
			}
		},
	);
}

export function useOAuthComplete() {
	const api = useApi();
	const qc = useQueryClient();
	return useSensitiveAction(
		async (vars: { providerId: string; state: string; code: string; redirect_uri?: string }) => {
			try {
				const result = unwrap(
					await api.POST("/v1/ai-providers/{provider_id}/auth/oauth/complete", {
						params: { path: { provider_id: vars.providerId } },
						body: { state: vars.state, code: vars.code, redirect_uri: vars.redirect_uri },
					}),
				);
				qc.invalidateQueries({ queryKey: KEY });
				return result;
			} catch (error) {
				toastApiError("Couldn't finish sign-in")(error);
				throw error;
			}
		},
	);
}

export function useCompleteProviderAccept() {
	const api = useApi();
	const qc = useQueryClient();
	return useSensitiveAction(
		async (vars: {
			providerId: string;
			state: string;
			code: string;
			redirect_uri?: string;
			idempotencyKey: string;
		}): Promise<AiProviderReadyAcceptResponse> => {
			try {
				const result = unwrap(
					await api.POST("/v1/ai-providers/{provider_id}/accept", {
						params: {
							path: { provider_id: vars.providerId },
							header: { "Idempotency-Key": vars.idempotencyKey },
						},
						body: {
							state: vars.state,
							code: vars.code,
							redirect_uri: vars.redirect_uri,
						},
					}),
				);
				void qc.invalidateQueries({ queryKey: KEY });
				return result;
			} catch (error) {
				toastApiError("Couldn't finish sign-in")(error);
				throw error;
			}
		},
	);
}
