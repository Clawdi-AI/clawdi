"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AiProviderPatch, AiProviderUpsert } from "@/hosted/v2/ai-providers/types";
import { toastApiError, unwrap, useApi } from "@/lib/api";

/** Typed data hooks for the AI Providers surface (cloud-api `/v1/ai-providers`). */

const KEY = ["ai-providers"] as const;

export function useAiProviders() {
	const api = useApi();
	return useQuery({
		queryKey: KEY,
		queryFn: async () => unwrap(await api.GET("/v1/ai-providers")),
	});
}

export function useCreateProvider() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (body: AiProviderUpsert) =>
			unwrap(await api.POST("/v1/ai-providers", { body, params: { query: { replace: false } } })),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
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

/** Silent patch used only to restore a snapshot after a multi-step edit fails. */
export function usePatchProviderQuiet() {
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
	return useMutation({
		mutationFn: async (vars: { providerId: string; value: string; runtime_env_name?: string }) =>
			unwrap(
				await api.POST("/v1/ai-providers/{provider_id}/auth/api-key", {
					params: { path: { provider_id: vars.providerId } },
					body: { value: vars.value, runtime_env_name: vars.runtime_env_name },
				}),
			),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
		onError: toastApiError("Couldn't save API key"),
	});
}

/** Static saved-field check; this endpoint does not probe credentials or connectivity. */
export function useCheckProviderFields() {
	const api = useApi();
	return useMutation({
		mutationFn: async (providerId: string) =>
			unwrap(
				await api.POST("/v1/ai-providers/{provider_id}/validate", {
					params: { path: { provider_id: providerId } },
				}),
			),
		onError: toastApiError("Couldn't check fields"),
	});
}

export function useOAuthStart() {
	const api = useApi();
	return useMutation({
		mutationFn: async (vars: { providerId: string; provider: string; redirect_uri?: string }) =>
			unwrap(
				await api.POST("/v1/ai-providers/{provider_id}/auth/oauth/start", {
					params: { path: { provider_id: vars.providerId } },
					body: { provider: vars.provider, redirect_uri: vars.redirect_uri },
				}),
			),
		onError: toastApiError("Couldn't start sign-in"),
	});
}

export function useOAuthComplete() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (vars: {
			providerId: string;
			state: string;
			code: string;
			redirect_uri?: string;
		}) =>
			unwrap(
				await api.POST("/v1/ai-providers/{provider_id}/auth/oauth/complete", {
					params: { path: { provider_id: vars.providerId } },
					body: { state: vars.state, code: vars.code, redirect_uri: vars.redirect_uri },
				}),
			),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
		onError: toastApiError("Couldn't finish sign-in"),
	});
}
