import createClient from "openapi-fetch";
import type { paths } from "./api.generated";
import { unwrapDeploymentList } from "./deploy";
import type { paths as DeployPaths } from "./deploy.generated";
import {
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export type AgentListQuery = paths["/v1/agents"]["get"]["parameters"]["query"];
export type SkillListQuery = paths["/v1/skills"]["get"]["parameters"]["query"];
export type MemoryListQuery = paths["/v1/memories"]["get"]["parameters"]["query"];
export type Project = paths["/v1/projects"]["get"]["responses"][200]["content"]["application/json"][number];
export type SessionListQuery = paths["/v1/sessions"]["get"]["parameters"]["query"];
export type SessionMessagesQuery =
	paths["/v1/sessions/{session_id}/messages"]["get"]["parameters"]["query"];

export function createCloudApiClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	return {
		listAgents: (query?: AgentListQuery, signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/agents", { ...init, params: { query } }), signal),
		listSkills: (query?: SkillListQuery, signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/skills", { ...init, params: { query } }), signal),
		listMemories: (query?: MemoryListQuery, signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/memories", { ...init, params: { query } }), signal),
		listProjects: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/projects", init), signal),
		getDashboardStats: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/dashboard/stats", init), signal),
		getAgent: (agentId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/agents/{agent_id}", {
						...init,
						params: { path: { agent_id: readResourceId(agentId) } },
					}),
				signal,
			),
		listSessions: (query?: SessionListQuery, signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/sessions", { ...init, params: { query } }), signal),
		getSession: (sessionId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/sessions/{session_id}", {
						...init,
						params: { path: { session_id: readResourceId(sessionId) } },
					}),
				signal,
			),
		getSessionMessages: (sessionId: string, query?: SessionMessagesQuery, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/sessions/{session_id}/messages", {
						...init,
						params: { path: { session_id: readResourceId(sessionId) }, query },
					}),
				signal,
			),
	};
}

export function createHostedApiClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<DeployPaths>({
		baseUrl: readApiBaseUrl(options.baseUrl, true),
		fetch: transport.fetch,
	});
	return {
		listDeployments: async (signal?: AbortSignal) => {
			const result = await transport.read((init) => api.GET("/v2/deployments", init), signal);
			try {
				return unwrapDeploymentList(result);
			} catch {
				throw new ApiClientResponseError();
			}
		},
		getDeployment: (deploymentId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v2/deployments/{deployment_id}", {
						...init,
						params: { path: { deployment_id: readResourceId(deploymentId) } },
					}),
				signal,
			),
		getDeploymentByRequest: (deployRequestId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v2/deployments/by-request/{deploy_request_id}", {
						...init,
						params: { path: { deploy_request_id: readResourceId(deployRequestId) } },
					}),
				signal,
			),
		getOperation: (operationId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v2/operations/{operation_id}", {
						...init,
						params: { path: { operation_id: readResourceId(operationId) } },
					}),
				signal,
			),
	};
}

export type CloudApiClient = ReturnType<typeof createCloudApiClient>;
export type HostedApiClient = ReturnType<typeof createHostedApiClient>;
