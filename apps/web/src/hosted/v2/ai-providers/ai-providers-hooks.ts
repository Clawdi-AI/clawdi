"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AiProviderUpsert } from "@/hosted/v2/ai-providers/types";
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

export function useUpsertProvider() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (body: AiProviderUpsert) =>
			unwrap(await api.POST("/v1/ai-providers", { body, params: { query: { replace: true } } })),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
		onError: toastApiError("Couldn't save provider"),
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
export function useUpsertProviderQuiet() {
	const api = useApi();
	return useMutation({
		mutationFn: async (body: AiProviderUpsert) =>
			unwrap(await api.POST("/v1/ai-providers", { body, params: { query: { replace: true } } })),
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

/** vault field name from a provider id (mirrors v1 safeVaultField). */
function safeVaultField(providerId: string): string {
	const n = providerId
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `${n || "provider"}_api_key`;
}

function exactVaultRef(projectId: string, slug: string, section: string, field: string): string {
	const parts = ["project", projectId, "vault", slug, "section", section, "field", field];
	return `clawdi://${parts.map((p) => encodeURIComponent(p)).join("/")}`;
}

/**
 * Store a BYOK key in the user's project vault and return the `clawdi://…`
 * secret_ref — the create path for `{type:"secret_ref"}` providers (v1
 * `saveApiKeyToVault`). The provider's auth is then set to that ref so the
 * runtime resolves the key from the vault, never the dashboard.
 */
export function useSaveApiKeyToVault() {
	const api = useApi();
	return useMutation({
		mutationFn: async (vars: { providerId: string; apiKey: string }): Promise<string> => {
			const proj = unwrap(await api.GET("/v1/projects/default"));
			const projectId = proj.project_id;
			const slug = "ai-providers";
			const section = "onboarding";
			const field = safeVaultField(vars.providerId);
			// Create-or-attach the vault (no create_only → attaches if it exists).
			unwrap(
				await api.POST("/v1/vault", {
					params: { query: { project_id: projectId } },
					body: { slug, name: "AI Providers" },
				}),
			);
			unwrap(
				await api.PUT("/v1/vault/{slug}/items", {
					params: { path: { slug }, query: { project_id: projectId } },
					body: { section, fields: { [field]: vars.apiKey } },
				}),
			);
			return exactVaultRef(projectId, slug, section, field);
		},
		onError: toastApiError("Couldn't save to vault"),
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

export function useValidateProvider() {
	const api = useApi();
	return useMutation({
		mutationFn: async (providerId: string) =>
			unwrap(
				await api.POST("/v1/ai-providers/{provider_id}/validate", {
					params: { path: { provider_id: providerId } },
				}),
			),
		onError: toastApiError("Couldn't validate"),
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
