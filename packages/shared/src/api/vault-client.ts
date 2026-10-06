import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import {
	type ApiClientOptions,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export type VaultCatalogQuery = NonNullable<paths["/v1/vault"]["get"]["parameters"]["query"]>;
/** Existing-resource lookups and mutations pin identity instead of falling back to a slug. */
export type VaultIdentity = Pick<components["schemas"]["VaultResponse"], "id" | "slug">;

export function createVaultClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	const params = (vault: VaultIdentity) => ({
		path: { slug: readResourceId(vault.slug) },
		query: { vault_id: readResourceId(vault.id) },
	});
	return {
		listRequests: (vault: VaultIdentity, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/vault/requests", {
						...init,
						params: {
							query: {
								slug: readResourceId(vault.slug),
								vault_id: readResourceId(vault.id),
								limit: 100,
							},
						},
					}),
				signal,
			),
		createRequest: (
			body: components["schemas"]["VaultSecretRequestCreate"],
			signal?: AbortSignal,
		) => transport.read((init) => api.POST("/v1/vault/requests", { ...init, body }), signal),
		list: (query?: VaultCatalogQuery, signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/vault", { ...init, params: { query } }), signal),
		get: (vault: VaultIdentity, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/vault/detail", {
						...init,
						params: {
							query: { vault_id: readResourceId(vault.id), slug: readResourceId(vault.slug) },
						},
					}),
				signal,
			),
		create: (body: components["schemas"]["VaultCreate"], signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/vault", { ...init, params: { query: { create_only: true } }, body }),
				signal,
			),
		/** Strict creation and attachment to the caller-selected Project in one server operation. */
		createInProject: (
			projectId: string,
			body: components["schemas"]["VaultCreate"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.POST("/v1/vault", {
						...init,
						params: { query: { create_only: true, project_id: readResourceId(projectId) } },
						body,
					}),
				signal,
			),
		sections: (vault: VaultIdentity, signal?: AbortSignal) =>
			transport.read(
				(init) => api.GET("/v1/vault/{slug}/items", { ...init, params: params(vault) }),
				signal,
			),
		upsert: (
			vault: VaultIdentity,
			body: components["schemas"]["VaultItemUpsert"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) => api.PUT("/v1/vault/{slug}/items", { ...init, params: params(vault), body }),
				signal,
			),
		deleteItems: (
			vault: VaultIdentity,
			body: components["schemas"]["VaultItemDelete"],
			globalDelete: boolean,
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.DELETE("/v1/vault/{slug}/items", {
						...init,
						params: {
							...params(vault),
							query: { ...params(vault).query, global_delete: globalDelete },
						},
						body,
					}),
				signal,
			),
		copyItems: (
			source: VaultIdentity,
			target: VaultIdentity,
			body: Omit<components["schemas"]["VaultItemsCopy"], "target_slug">,
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.POST("/v1/vault/{slug}/items/copy", {
						...init,
						params: {
							...params(source),
							query: { ...params(source).query, target_vault_id: readResourceId(target.id) },
						},
						body: { ...body, target_slug: readResourceId(target.slug) },
					}),
				signal,
			),
		remove: (vault: VaultIdentity, signal?: AbortSignal) =>
			transport.read(
				(init) => api.DELETE("/v1/vault/{slug}", { ...init, params: params(vault) }),
				signal,
			),
		attach: (vault: VaultIdentity, projectId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/vault/{slug}/attachments/{project_id}", {
						...init,
						params: {
							path: { slug: readResourceId(vault.slug), project_id: readResourceId(projectId) },
							query: { vault_id: readResourceId(vault.id) },
						},
					}),
				signal,
			),
		/** Legacy create-or-attach is slug based; use attach for a selected stable identity. */
		createOrAttachBySlug: (
			vault: Pick<components["schemas"]["VaultResponse"], "slug" | "name">,
			projectId: string,
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.POST("/v1/vault", {
						...init,
						params: { query: { project_id: readResourceId(projectId) } },
						body: { slug: readResourceId(vault.slug), name: vault.name },
					}),
				signal,
			),
		detach: (vault: VaultIdentity, projectId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.DELETE("/v1/vault/{slug}", {
						...init,
						params: {
							...params(vault),
							query: { ...params(vault).query, project_id: readResourceId(projectId) },
						},
					}),
				signal,
			),
	};
}
export type VaultClient = ReturnType<typeof createVaultClient>;
