import createClient from "openapi-fetch";
import type { paths } from "./api.generated";
import {
	type ApiClientOptions,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export function createAgentProjectClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	return {
		updateProjectAgents: (
			projectId: string,
			body: paths["/v1/projects/{project_id}/agents"]["patch"]["requestBody"]["content"]["application/json"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.PATCH("/v1/projects/{project_id}/agents", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
						body,
					}),
				signal,
			),
		listBindings: (agentId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/agents/{agent_id}/project-bindings", {
						...init,
						params: { path: { agent_id: readResourceId(agentId) } },
					}),
				signal,
			),
		link: (agentId: string, projectId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/agents/{agent_id}/project-bindings/context", {
						...init,
						params: { path: { agent_id: readResourceId(agentId) } },
						body: { project_id: readResourceId(projectId) },
					}),
				signal,
			),
		unlink: (agentId: string, bindingId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.DELETE("/v1/agents/{agent_id}/project-bindings/{binding_id}", {
						...init,
						params: {
							path: { agent_id: readResourceId(agentId), binding_id: readResourceId(bindingId) },
						},
					}),
				signal,
			),
		reorder: (
			agentId: string,
			body: paths["/v1/agents/{agent_id}/project-bindings/context/reorder"]["patch"]["requestBody"]["content"]["application/json"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.PATCH("/v1/agents/{agent_id}/project-bindings/context/reorder", {
						...init,
						params: { path: { agent_id: readResourceId(agentId) } },
						body,
					}),
				signal,
			),
	};
}

export type AgentProjectClient = ReturnType<typeof createAgentProjectClient>;
