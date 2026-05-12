import { env } from "@/lib/env";

/**
 * Agent-friendly format proxies for shared sessions.
 *
 * Visitor-facing URL is `/s/{id}.md` (and `.json`); `next.config.ts`
 * rewrites those to `/s/{id}/{format}`, which is what this handler
 * serves. URL bar still shows the `.ext` form.
 *
 * `id` is always a session UUID — matches the backend's canonical
 * `/api/public/sessions/{session_id}` route.
 *
 * **Anonymous-only proxy**: no Clerk auth forwarded. The middleware
 * matcher in `proxy.ts` excludes `.md` / `.json` extensions to keep
 * static-file requests cheap, which means clerkMiddleware never runs
 * on this route and `auth()` would throw. The target consumer is
 * unauthenticated agents (ChatGPT / Claude WebFetch / curl); the
 * owner-private "export my session" path goes through the dashboard's
 * owner-auth `/api/sessions/{id}/export.md` instead.
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

	const upstreamPath = format === "md" ? "export.md" : "export.json";
	const upstream = `${env.NEXT_PUBLIC_API_URL}/api/public/sessions/${id}/${upstreamPath}`;

	const res = await fetch(upstream, { cache: "no-store" });

	if (!res.ok) {
		return new Response(await res.text(), {
			status: res.status,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}

	// NO cache-control — revocation / permission-toggle must take effect
	// immediately. Stream the upstream body unchanged.
	return new Response(res.body, {
		status: 200,
		headers: {
			"content-type": FORMAT_MEDIA_TYPE[format],
		},
	});
}
