import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import {
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
