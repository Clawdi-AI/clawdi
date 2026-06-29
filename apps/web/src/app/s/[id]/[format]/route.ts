import type { paths } from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { env } from "@/lib/env";

/**
 * Agent-friendly format proxies for shared sessions.
 *
 * Visitor-facing URL is `/s/{id}.md` (and `.json`); TanStack Start routes
 * those extension paths directly to this handler.
 *
 * `id` is always a session UUID — matches the backend's canonical
 * `/api/public/sessions/{session_id}` route.
 *
 * **Anonymous-only proxy**: no Clerk token is forwarded to the backend.
 * TanStack Start may still run Clerk request middleware for browser state,
 * but this handler intentionally avoids `auth()`. The target consumer is
 * unauthenticated agents (ChatGPT / Claude WebFetch / curl); the owner-private
 * "export my session" path goes through the dashboard's owner-auth
 * `/api/sessions/{id}/export.md` instead.
 *
 * Behavior: 200 when the session has an active `kind='link'` permission,
 * 401 otherwise (backend status passed through verbatim).
 */

const ALLOWED_FORMATS = new Set(["md", "json"]);

const FORMAT_MEDIA_TYPE: Record<string, string> = {
	md: "text/markdown; charset=utf-8",
	json: "application/json; charset=utf-8",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ id: string; format: string }> },
): Promise<Response> {
	const { id, format } = await params;

	if (!ALLOWED_FORMATS.has(format)) {
		return new Response("Not found", { status: 404 });
	}
	if (!UUID_RE.test(id)) {
		return new Response("Not found", { status: 404 });
	}

	const api = createClient<paths>({ baseUrl: env.NEXT_PUBLIC_API_URL });
	const result =
		format === "md"
			? await api.GET("/api/public/sessions/{session_id}/export.md", {
					params: { path: { session_id: id } },
					parseAs: "text",
					cache: "no-store",
				})
			: await api.GET("/api/public/sessions/{session_id}/export.json", {
					params: { path: { session_id: id } },
					parseAs: "text",
					cache: "no-store",
				});

	if (result.error !== undefined) {
		return new Response(String(result.error), {
			status: result.response.status,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}

	// NO cache-control — revocation / permission-toggle must take effect immediately.
	return new Response(result.data, {
		status: 200,
		headers: {
			"content-type": FORMAT_MEDIA_TYPE[format],
		},
	});
}
