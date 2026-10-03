import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import {
	type ApiClientOptions,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";
import { requireSkillContentHash } from "./skill-content";

export function createSkillClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	const path = (projectId: string, skillKey: string) => ({
		project_id: readResourceId(projectId),
		skill_key: readResourceId(skillKey),
	});
	return {
		get: (projectId: string, skillKey: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/projects/{project_id}/skills/{skill_key}", {
						...init,
						params: { path: path(projectId, skillKey) },
					}),
				signal,
			),
		create: (
			projectId: string,
			body: components["schemas"]["SkillCreateRequest"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.POST("/v1/projects/{project_id}/skills", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
						body,
					}),
				signal,
			),
		update: (
			projectId: string,
			skillKey: string,
			body: components["schemas"]["SkillContentUpdateRequest"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.PUT("/v1/projects/{project_id}/skills/{skill_key}/content", {
						...init,
						params: { path: path(projectId, skillKey) },
						body,
					}),
				signal,
			),
		remove: (projectId: string, skillKey: string, contentHash: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
						...init,
						params: {
							path: path(projectId, skillKey),
							query: { expected_content_hash: requireSkillContentHash(contentHash) },
						},
					}),
				signal,
			),
		install: (
			projectId: string,
			body: components["schemas"]["SkillInstallRequest"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.POST("/v1/projects/{project_id}/skills/install", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
						body,
					}),
				signal,
			),
	};
}
export type SkillClient = ReturnType<typeof createSkillClient>;
