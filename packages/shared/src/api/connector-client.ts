import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import {
	type ApiClientOptions,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export type ConnectorCatalogQuery = NonNullable<
	paths["/v1/connectors/available"]["get"]["parameters"]["query"]
>;

export function createConnectorClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	const appPath = (name: string) => ({ app_name: readResourceId(name) });
	const connectionPath = (id: string) => ({ connection_id: readResourceId(id) });
	return {
		list: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/connectors", init), signal),
		catalog: (query?: ConnectorCatalogQuery, signal?: AbortSignal) =>
			transport.read(
				(init) => api.GET("/v1/connectors/available", { ...init, params: { query } }),
				signal,
			),
		getApp: (name: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/connectors/available/{app_name}", {
						...init,
						params: { path: appPath(name) },
					}),
				signal,
			),
		authFields: (name: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/connectors/{app_name}/auth-fields", {
						...init,
						params: { path: appPath(name) },
					}),
				signal,
			),
		tools: (name: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/connectors/{app_name}/tools", { ...init, params: { path: appPath(name) } }),
				signal,
			),
		connect: (name: string, body: components["schemas"]["ConnectRequest"], signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/connectors/{app_name}/connect", {
						...init,
						params: { path: appPath(name) },
						body,
					}),
				signal,
			),
		connectCredentials: (
			name: string,
			body: components["schemas"]["ConnectorCredentialsConnectRequest"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.POST("/v1/connectors/{app_name}/connect-credentials", {
						...init,
						params: { path: appPath(name) },
						body,
					}),
				signal,
			),
		update: (
			id: string,
			body: components["schemas"]["ConnectorUpdateRequest"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.PATCH("/v1/connectors/{connection_id}", {
						...init,
						params: { path: connectionPath(id) },
						body,
					}),
				signal,
			),
		disconnect: (id: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.DELETE("/v1/connectors/{connection_id}", {
						...init,
						params: { path: connectionPath(id) },
					}),
				signal,
			),
	};
}
export type ConnectorClient = ReturnType<typeof createConnectorClient>;
