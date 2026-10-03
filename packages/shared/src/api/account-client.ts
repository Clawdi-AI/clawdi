import createClient from "openapi-fetch";
import type { paths } from "./api.generated";
import { createReadTransport, readApiBaseUrl, readResourceId, type ApiClientOptions } from "./read-transport";

export type ApiKeyCreate = paths["/v1/auth/keys"]["post"]["requestBody"]["content"]["application/json"];
export type SettingsUpdate = paths["/v1/settings"]["patch"]["requestBody"]["content"]["application/json"];

export function createAccountApiClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({ baseUrl: readApiBaseUrl(options.baseUrl), fetch: transport.fetch });
	return {
		getSettings: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/settings", init), signal),
		updateSettings: (body: SettingsUpdate, signal?: AbortSignal) =>
			transport.read((init) => api.PATCH("/v1/settings", { ...init, body }), signal),
		listApiKeys: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/auth/keys", init), signal),
		createApiKey: (body: ApiKeyCreate, signal?: AbortSignal) =>
			transport.read((init) => api.POST("/v1/auth/keys", { ...init, body }), signal),
		revokeApiKey: (keyId: string, signal?: AbortSignal) =>
			transport.read(
				(init) => api.DELETE("/v1/auth/keys/{key_id}", { ...init, params: { path: { key_id: readResourceId(keyId) } } }),
				signal,
			),
	};
}

export type AccountApiClient = ReturnType<typeof createAccountApiClient>;
