import chalk from "chalk";
import { ApiError } from "./api-client";
import { getAuth, getConfig } from "./config";
import type { ProjectBrief } from "./project-resolver";

export interface ProjectAuthContext {
	apiUrl: string;
	apiKey: string;
}

export function requireProjectAuth(): ProjectAuthContext {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		throw new Error("Not signed in. Run `clawdi auth login` first.");
	}
	return { apiUrl, apiKey: auth.apiKey };
}

export function projectAuthOrExit(): ProjectAuthContext | null {
	try {
		return requireProjectAuth();
	} catch {
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
	return r.json() as Promise<T>;
}

export function projectAlias(project: Pick<ProjectBrief, "slug" | "is_owner" | "owner_handle">) {
	if (project.is_owner === false && project.owner_handle) {
		return `@${project.owner_handle}/${project.slug}`;
	}
	return project.slug;
}
