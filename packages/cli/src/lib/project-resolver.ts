import type { components } from "@clawdi/shared/api";
import { ApiClient, unwrap } from "./api-client";
import { isUuid } from "./cli-options";

/**
 * Resolve a user-supplied `<project>` argument to a backend project UUID.
 *
 * Accepts:
 *   - A full UUID → returned as-is (no round-trip).
 *   - A slug (matches `Project.slug`) → resolved via GET /v1/projects.
 *   - A human name → matched against `Project.name` (case-insensitive)
 *     after slug match fails.
 *   - `default` or omitted → returns the user's default-write project.
 *
 * Throws on ambiguity (multiple matches) or no match.
 *
 * The caller passes the raw `apiUrl` + bearer instead of an
 * `ApiClient` instance so callers can supply their credential and API origin.
 */

export type ProjectBrief = components["schemas"]["ProjectResponse"];

export async function resolveProjectId(
	apiUrl: string,
	bearer: string,
	input: string | undefined,
): Promise<string> {
	const api = new ApiClient({ authToken: bearer, baseUrl: apiUrl });
	if (!input || input === "default") {
		const def = unwrap(await api.GET("/v1/projects/default"));
		return def.project_id;
	}
	if (isUuid(input)) return input;

	const projects = await listProjects(apiUrl, bearer);
	const ownerQualified = parseOwnerQualifiedProject(input);
	const candidates = ownerQualified
		? projects.filter((s) => s.owner_handle?.toLowerCase() === ownerQualified.ownerHandle)
		: projects;
	const needle = (ownerQualified?.project ?? input).toLowerCase();
	const slugMatches = candidates.filter((s) => s.slug.toLowerCase() === needle);
	const nameMatches = candidates.filter((s) => s.name.toLowerCase() === needle);
	const matches = slugMatches.length > 0 ? slugMatches : nameMatches;

	if (matches.length === 0) {
		throw new Error(
			`No project matches '${input}'. Try \`clawdi project list\` to see your projects.`,
		);
	}
	if (matches.length > 1) {
		const ids = matches.map((m) => m.id).join(", ");
		throw new Error(
			`'${input}' matches ${matches.length} projects (${ids}). Use the UUID directly.`,
		);
	}
	return matches[0].id;
}

function parseOwnerQualifiedProject(
	input: string,
): { ownerHandle: string; project: string } | null {
	if (!input.startsWith("@")) return null;
	const slash = input.indexOf("/");
	if (slash <= 1 || slash === input.length - 1) return null;
	return {
		ownerHandle: input.slice(1, slash).toLowerCase(),
		project: input.slice(slash + 1),
	};
}

export async function listProjects(apiUrl: string, bearer: string): Promise<ProjectBrief[]> {
	return unwrap(await new ApiClient({ authToken: bearer, baseUrl: apiUrl }).GET("/v1/projects"));
}
