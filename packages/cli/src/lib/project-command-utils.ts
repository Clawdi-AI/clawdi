import { ApiClient, ApiError, readJson } from "./api-client";
import { getClawdiAccessToken } from "./clerk-oauth";
import { getConfig } from "./config";
import type { ProjectBrief } from "./project-resolver";
import { requireAuth } from "./require-auth";

export interface ProjectAuthContext {
	apiUrl: string;
	apiKey: string;
}

export async function requireProjectAuth(): Promise<ProjectAuthContext> {
	requireAuth();
	const { apiUrl } = getConfig();
	return { apiUrl, apiKey: await getClawdiAccessToken(apiUrl) };
}

export async function projectAuthOrExit(): Promise<ProjectAuthContext | null> {
	return await requireProjectAuth();
}

export async function authedJson<T>(
	apiUrl: string,
	apiKey: string,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const api = new ApiClient({ authToken: apiKey, baseUrl: apiUrl });
	const r = await api.request(path, init);
	if (!r.ok) {
		throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	}
	return await readJson<T>(r, path);
}

export function projectAlias(project: Pick<ProjectBrief, "slug" | "is_owner" | "owner_handle">) {
	if (project.is_owner === false && project.owner_handle) {
		return `@${project.owner_handle}/${project.slug}`;
	}
	return project.slug;
}
