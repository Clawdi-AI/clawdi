import { ApiError } from "./api-client";

/**
 * Resolve a user-supplied `<scope>` argument to a backend project UUID.
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
 * `ApiClient` instance because the sharing endpoints aren't in the
 * typed openapi schema yet (sharing routes land in a future schema
 * regen). Once they're typed, this can switch to ApiClient and
 * drop the manual auth header.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ScopeBrief {
	id: string;
	name: string;
	slug: string;
	kind: string;
	is_owner?: boolean;
}

async function authedGet<T>(apiUrl: string, bearer: string, path: string): Promise<T> {
	const r = await fetch(`${apiUrl}${path}`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (!r.ok) {
		throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	}
	return r.json() as Promise<T>;
}

export async function resolveScopeId(
	apiUrl: string,
	bearer: string,
	input: string | undefined,
): Promise<string> {
	if (!input || input === "default") {
		const r = await fetch(`${apiUrl}/api/projects/default`, {
			headers: { Authorization: `Bearer ${bearer}` },
		});
		if (r.ok) {
			const def = (await r.json()) as { project_id: string };
			return def.project_id;
		}
		// Backward compat with pre-project route names.
		const def = await authedGet<{ scope_id: string }>(apiUrl, bearer, "/api/scopes/default");
		return def.scope_id;
	}
	if (UUID_RE.test(input)) return input;

	const scopes = await listScopes(apiUrl, bearer);
	const needle = input.toLowerCase();
	const slugMatches = scopes.filter((s) => s.slug.toLowerCase() === needle);
	const nameMatches = scopes.filter((s) => s.name.toLowerCase() === needle);
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

export async function listScopes(apiUrl: string, bearer: string): Promise<ScopeBrief[]> {
	const projectResponse = await fetch(`${apiUrl}/api/projects`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (projectResponse.ok) {
		return (await projectResponse.json()) as ScopeBrief[];
	}
	// Backward compat with pre-project route names.
	return authedGet<ScopeBrief[]>(apiUrl, bearer, "/api/scopes");
}
