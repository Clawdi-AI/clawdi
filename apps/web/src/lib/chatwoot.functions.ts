import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { createChatwootIdentifierHash } from "@/lib/chatwoot-hmac.server";

/** Returns an identity hash for the Clerk user authenticated on this request. */
export const getChatwootIdentifierHash = createServerFn({ method: "GET" }).handler(async () => {
	setResponseHeader("cache-control", "private, no-store");
	const { userId } = await auth();
	const identifierHash = createChatwootIdentifierHash(userId, process.env.CHATWOOT_HMAC_SECRET);
	return identifierHash ? { identifierHash } : null;
});
