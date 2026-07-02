import { ApiError, readJson } from "./api-client";

/**
 * Resolve a user-supplied `<project>` argument to a backend project UUID.
 *
 * Accepts:
 *   - A full UUID → returned as-is (no round-trip).
 *   - A slug (matches `Project.slug`) → resolved via GET /api/projects.
 *   - A human name → matched against `Project.name` (case-insensitive)
 *     after slug match fails.
 *   - `default` or omitted → returns the user's default-write project.
 *
 * Throws on ambiguity (multiple matches) or no match.
 *
 * The caller passes the raw `apiUrl` + bearer instead of an
 * `ApiClient` instance because this helper is also used in early
 * bootstrap flows before typed clients are available.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectBrief {
	id: string;
	name: string;
	slug: string;
	kind: string;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

export async function resolveProjectId(
	apiUrl: string,
	bearer: string,
	input: string | undefined,
): Promise<string> {
	if (!input || input === "default") {
		const r = await fetch(`${apiUrl}/v1/projects/default`, {
			headers: { Authorization: `Bearer ${bearer}` },
		});
		if (!r.ok) {
			throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
		}
		const def = await readJson<{ project_id: string }>(r, "/v1/projects/default");
		return def.project_id;
	}
	if (UUID_RE.test(input)) return input;

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
	const projectResponse = await fetch(`${apiUrl}/v1/projects`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (!projectResponse.ok) {
		throw new ApiError({
			status: projectResponse.status,
			body: await projectResponse.text(),
			hint: "",
		});
	}
	return await readJson<ProjectBrief[]>(projectResponse, "/v1/projects");
}
