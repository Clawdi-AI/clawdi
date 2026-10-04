import { createMiddleware } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
export function clerkMiddleware() {
	return createMiddleware().server(({ next }) => next());
}
export async function auth() {
	const userId = getCookie("test-user") ?? null;
	return { userId, sessionId: userId ? `session-${userId}` : null };
}
