import chalk from "chalk";
import { ApiError, readJson } from "./api-client";
import { ClerkOAuthError, getClawdiAccessToken } from "./clerk-oauth";
import { getConfig } from "./config";
import type { ProjectBrief } from "./project-resolver";

export interface ProjectAuthContext {
	apiUrl: string;
	apiKey: string;
}

export async function requireProjectAuth(): Promise<ProjectAuthContext> {
	const { apiUrl } = getConfig();
	return { apiUrl, apiKey: await getClawdiAccessToken(apiUrl) };
}

export async function projectAuthOrExit(): Promise<ProjectAuthContext | null> {
	try {
		return await requireProjectAuth();
	} catch (error) {
		if (!(error instanceof ClerkOAuthError) || error.code !== "oauth_login_required") {
			throw error;
		}
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return null;
	}
}

export async function authedJson<T>(
	apiUrl: string,
	apiKey: string,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const r = await fetch(`${apiUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...(init.headers ?? {}),
		},
	});
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
