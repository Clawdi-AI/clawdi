import { auth } from "@clerk/tanstack-react-start/server";
import { createFileRoute } from "@tanstack/react-router";
import { createChatwootIdentifierHash } from "@/lib/chatwoot-hmac.server";
import { env } from "@/lib/env";

const NO_STORE = { "cache-control": "private, no-store" };

/**
 * Chatwoot identity hash for the app's live chat, which has no Web session cookie: Clerk's
 * request middleware authenticates the app's `Authorization: Bearer` session token.
 */
export async function GET(): Promise<Response> {
	// Dev auth bypass runs without Clerk's request middleware.
	if (env.VITE_DEV_AUTH_BYPASS) return new Response(null, { status: 404, headers: NO_STORE });
	const { userId } = await auth();
	if (!userId) return new Response(null, { status: 401, headers: NO_STORE });
	const identifierHash = createChatwootIdentifierHash(userId, process.env.CHATWOOT_HMAC_SECRET);
	if (!identifierHash) return new Response(null, { status: 404, headers: NO_STORE });
	return Response.json({ identifierHash }, { headers: NO_STORE });
}

export const Route = createFileRoute("/api/chatwoot/identity")({
	server: { handlers: { GET } },
});
