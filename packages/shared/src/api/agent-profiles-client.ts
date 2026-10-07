import createClient from "openapi-fetch";
import type { paths } from "./api.generated";
import {
	type ApiClientOptions,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export const AGENT_PROFILES_PATH = "/v1/agents/{agent_id}/profiles" satisfies keyof paths;

export function createAgentProfilesClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	return {
		listProfiles: (agentId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET(AGENT_PROFILES_PATH, {
						...init,
						params: { path: { agent_id: readResourceId(agentId) } },
					}),
				signal,
			),
	};
}

export type AgentProfilesClient = ReturnType<typeof createAgentProfilesClient>;
