import createClient from "openapi-fetch";
import { type AgentOwnership, agentDisconnectEligibility, type ClientPlatform } from "../client";
import type { components, paths } from "./api.generated";
import {
	ApiClientError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export const MAX_AGENT_AVATAR_BYTES = 2 * 1024 * 1024;
export const AGENT_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export function normalizeAgentDisplayName(value: string): string | null {
	const name = value.replace(/[\uD800-\uDFFF]/gu, "").trim();
	if (Array.from(name).length > 120) throw new ApiClientError(400, "invalid_agent_name");
	return name || null;
}
export function syncAgentNameDraft(current: string, previous: string | undefined, next: string) {
	return previous === undefined || current === previous ? next : current;
}

function matchingAgent(value: components["schemas"]["AgentResponse"], id: string) {
	if (!value || value.id !== id) throw new ApiClientResponseError();
	return value;
}

/** Identity mutations never automatically retry or expose credentials. */
export function createAgentSettingsClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	const params = (id: string) => ({ path: { agent_id: readResourceId(id) } });
	return {
		setName: async (id: string, name: string, signal?: AbortSignal) => {
			const body: components["schemas"]["EnvironmentUpdate"] = {
				display_name: normalizeAgentDisplayName(name),
			};
			return matchingAgent(
				await transport.read(
					(init) => api.PATCH("/v1/agents/{agent_id}", { ...init, params: params(id), body }),
					signal,
				),
				id,
			);
		},
		clearAvatar: async (id: string, signal?: AbortSignal) =>
			matchingAgent(
				await transport.read(
					(init) => api.DELETE("/v1/agents/{agent_id}/avatar", { ...init, params: params(id) }),
					signal,
				),
				id,
			),
		uploadAvatar: async (id: string, file: Blob, signal?: AbortSignal) => {
			if (
				!file.size ||
				file.size > MAX_AGENT_AVATAR_BYTES ||
				!AGENT_AVATAR_MIME_TYPES.some((type) => type === file.type)
			)
				throw new ApiClientError(400, "invalid_agent_avatar");
			const form = new FormData();
			const filename = `agent-avatar.${file.type.slice("image/".length)}`;
			form.append("file", file, filename);
			// Generated multipart binary fields are strings. The serializer supplies
			// the real Blob/File while the typed field still follows the wire schema.
			return matchingAgent(
				await transport.read(
					(init) =>
						api.POST("/v1/agents/{agent_id}/avatar", {
							...init,
							params: params(id),
							body: { file: filename },
							bodySerializer: () => form,
						}),
					signal,
				),
				id,
			);
		},
		disconnect: async (
			id: string,
			context: {
				platform: ClientPlatform;
				ownership: AgentOwnership | null;
				explicitIdentity?: boolean | null;
			},
			signal?: AbortSignal,
		) => {
			const eligibility = agentDisconnectEligibility({ ...context, agentId: id });
			if (!eligibility.eligible) throw new ApiClientError(403, eligibility.reason);
			await transport.read(async (init) => {
				const result = await api.DELETE("/v1/agents/{agent_id}", { ...init, params: params(id) });
				if (result.response.ok && result.response.status !== 204)
					throw new ApiClientResponseError();
				return { ...result, data: result.response.status === 204 ? null : result.data };
			}, signal);
		},
	};
}
export type AgentSettingsClient = ReturnType<typeof createAgentSettingsClient>;
