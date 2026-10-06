import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import {
	type ApiClientOptions,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

type Schemas = components["schemas"];
export type ChannelAccount = Schemas["ChannelAccountResponse"];
export type ChannelBot = Schemas["ChannelBotPoolItem"];
export type ChannelLink = Omit<Schemas["ChannelAgentLinkResponse"], "agent_token">;
export type ChannelPairing = Omit<Schemas["ChannelPairCodeResponse"], "agent_token">;

function withoutAgentToken<T extends { agent_token?: string | null }>(value: T) {
	const { agent_token: _secret, ...safe } = value;
	return safe;
}

/** Mutations are explicit, never retried. Pairing responses belong in transient UI state only. */
export function createChannelClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	const path = (id: string) => ({ account_id: readResourceId(id) });
	return {
		create: async (body: Schemas["ChannelAccountCreate"], signal?: AbortSignal) => {
			const result = await transport.read(
				(init) => api.POST("/v1/channels", { ...init, body }),
				signal,
			);
			return {
				id: result.id,
				name: result.name,
				provider: result.provider,
				webhook_url: result.webhook_url,
			};
		},
		list: (signal?: AbortSignal) => transport.read((init) => api.GET("/v1/channels", init), signal),
		pool: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/channels/bot-pool", init), signal),
		health: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/channels/health", init), signal),
		get: (id: string, signal?: AbortSignal) =>
			transport.read(
				(init) => api.GET("/v1/channels/{account_id}", { ...init, params: { path: path(id) } }),
				signal,
			),
		links: async (id: string, signal?: AbortSignal) =>
			(
				await transport.read(
					(init) =>
						api.GET("/v1/channels/{account_id}/agent-links", {
							...init,
							params: { path: path(id) },
						}),
					signal,
				)
			).map(withoutAgentToken),
		agentLinks: async (agentId: string, signal?: AbortSignal) =>
			(
				await transport.read(
					(init) =>
						api.GET("/v1/channels/agent-links", {
							...init,
							params: { query: { agent_id: readResourceId(agentId) } },
						}),
					signal,
				)
			).map(withoutAgentToken),
		bindings: (id: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/channels/{account_id}/bindings", { ...init, params: { path: path(id) } }),
				signal,
			),
		activity: (id: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/channels/{account_id}/activity", {
						...init,
						params: { path: path(id), query: { limit: 50 } },
					}),
				signal,
			),
		link: async (id: string, agentId: string, replace: boolean, signal?: AbortSignal) =>
			withoutAgentToken(
				await transport.read(
					(init) =>
						api.POST("/v1/channels/{account_id}/agent-links", {
							...init,
							params: { path: path(id) },
							body: {
								agent_id: readResourceId(agentId),
								...(replace ? { replace_existing_provider_link: true } : {}),
							},
						}),
					signal,
				),
			),
		unlink: (id: string, linkId: string, signal?: AbortSignal) =>
			transport.read(async (init) => {
				const result = await api.DELETE("/v1/channels/{account_id}/agent-links/{link_id}", {
					...init,
					params: { path: { ...path(id), link_id: readResourceId(linkId) } },
				});
				return { ...result, data: result.response.status === 204 ? null : result.data };
			}, signal),
		pair: async (id: string, linkId: string, signal?: AbortSignal) =>
			withoutAgentToken(
				await transport.read(
					(init) =>
						api.POST("/v1/channels/{account_id}/pair-codes", {
							...init,
							params: { path: path(id) },
							body: { agent_link_id: readResourceId(linkId), ttl_seconds: 300 },
						}),
					signal,
				),
			),
		unpair: (id: string, bindingId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.DELETE("/v1/channels/{account_id}/bindings/{binding_id}", {
						...init,
						params: { path: { ...path(id), binding_id: readResourceId(bindingId) } },
					}),
				signal,
			),
		remove: (id: string, signal?: AbortSignal) =>
			transport.read(async (init) => {
				const result = await api.DELETE("/v1/channels/{account_id}", {
					...init,
					params: { path: path(id) },
				});
				return { ...result, data: result.response.status === 204 ? null : result.data };
			}, signal),
		syncCommands: (id: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/channels/{account_id}/commands/sync", {
						...init,
						params: { path: path(id) },
						body: {},
					}),
				signal,
			),
	};
}

export type ChannelClient = ReturnType<typeof createChannelClient>;
