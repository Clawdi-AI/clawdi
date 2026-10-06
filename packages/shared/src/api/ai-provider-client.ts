import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import {
	ApiClientError,
	type ApiClientOptions,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export type SavedAiProvider = components["schemas"]["AiProviderResponse"];

/** Explicit user actions only: validation does not prove upstream connectivity. */
export function createAiProviderClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	const path = (id: string) => ({ provider_id: readResourceId(id) });
	return {
		startDeviceAuthorization: (id: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/ai-providers/{provider_id}/auth/oauth/device/start", {
						...init,
						params: { path: path(id) },
						body: { provider: "codex" },
					}),
				signal,
			),
		pollDeviceAuthorization: (id: string, state: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/ai-providers/{provider_id}/auth/oauth/device/poll", {
						...init,
						params: { path: path(id) },
						body: { state },
					}),
				signal,
			),
		accept: async (
			body: components["schemas"]["AiProviderAcceptRequest"],
			key: string,
			signal?: AbortSignal,
		) => {
			if (!/^[\x21-\x7e]{1,200}$/.test(key))
				throw new ApiClientError(400, "invalid_idempotency_key");
			return transport.read(
				(init) =>
					api.POST("/v1/ai-providers/accept", {
						...init,
						body,
						params: { header: { "Idempotency-Key": key } },
					}),
				signal,
			);
		},
		list: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/ai-providers", init), signal),
		update: (id: string, body: components["schemas"]["AiProviderPatch"], signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.PATCH("/v1/ai-providers/{provider_id}", {
						...init,
						params: { path: path(id) },
						body,
					}),
				signal,
			),
		validate: (id: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/ai-providers/{provider_id}/validate", {
						...init,
						params: { path: path(id) },
					}),
				signal,
			),
	};
}

export type AiProviderClient = ReturnType<typeof createAiProviderClient>;
