import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import {
	ApiClientError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";
import { requireSkillContentHash } from "./skill-content";

export const MAX_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024;
export function skillArchiveFilename(skillKey: string) {
	return `${readResourceId(skillKey)
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.slice(0, 200)}.tar.gz`;
}

export function buildSkillArchiveForm(skillKey: string, archive: Blob, createOnly = false) {
	const filename = skillArchiveFilename(skillKey);
	if (!archive.size || archive.size > MAX_SKILL_ARCHIVE_BYTES)
		throw new ApiClientError(400, "invalid_skill_archive_size");
	const form = new FormData();
	form.append("skill_key", skillKey);
	form.append("file", archive, filename);
	form.append("create_only", String(createOnly));
	return form;
}

export function validateSkillUploadReceipt(
	result: components["schemas"]["SkillUploadResponse"],
	skillKey: string,
) {
	if (!result || result.skill_key !== skillKey || !/^[a-f0-9]{64}$/.test(result.content_hash))
		throw new ApiClientResponseError();
	return result;
}

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
		download: async (projectId: string, skillKey: string, signal?: AbortSignal): Promise<Blob> => {
			const archive = await transport.read(
				(init) =>
					api.GET("/v1/projects/{project_id}/skills/{skill_key}/download", {
						...init,
						params: { path: path(projectId, skillKey) },
						parseAs: "blob",
					}),
				signal,
			);
			if (!archive.size || archive.size > MAX_SKILL_ARCHIVE_BYTES)
				throw new ApiClientResponseError();
			return archive;
		},
		upload: async (
			projectId: string,
			skillKey: string,
			archive: Blob,
			createOnly = false,
			signal?: AbortSignal,
		) => {
			readResourceId(projectId);
			const filename = skillArchiveFilename(skillKey);
			const form = buildSkillArchiveForm(skillKey, archive, createOnly);
			const result = await transport.read(
				(init) =>
					api.POST("/v1/projects/{project_id}/skills/upload", {
						...init,
						params: { path: { project_id: projectId } },
						body: { skill_key: skillKey, file: filename, create_only: createOnly },
						bodySerializer: () => form,
					}),
				signal,
			);
			return validateSkillUploadReceipt(result, skillKey);
		},
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
