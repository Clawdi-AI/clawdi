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

export function projectAlias(project: Pick<ProjectBrief, "slug" | "is_owner" | "owner_handle">) {
	if (project.is_owner === false && project.owner_handle) {
		return `@${project.owner_handle}/${project.slug}`;
	}
	return project.slug;
}
