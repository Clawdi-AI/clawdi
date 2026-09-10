import type { useAuth, useClerk } from "@clerk/tanstack-react-start";
import type { auth } from "@clerk/tanstack-react-start/server";
import { redirect } from "@tanstack/react-router";

export type RouteAuth =
	| { status: "loading" | "unavailable" | "signed-out" }
	| { status: "signed-in"; userId: string; sessionId: string };

export function routeAuthIdentity(auth: RouteAuth): string | null {
	return auth.status === "signed-in" ? JSON.stringify([auth.userId, auth.sessionId]) : null;
}

export function resolveRouteAuth(
	auth: Pick<ReturnType<typeof useAuth>, "isLoaded" | "isSignedIn" | "userId" | "sessionId">,
	status: ReturnType<typeof useClerk>["status"],
): RouteAuth {
	if (status === "degraded" || status === "error") return { status: "unavailable" };
	if (!auth.isLoaded) return { status: "loading" };
	if (!auth.isSignedIn || !auth.userId || !auth.sessionId) return { status: "signed-out" };
	return { status: "signed-in", userId: auth.userId, sessionId: auth.sessionId };
}

export function requireRouteIdentity(
	{ userId, sessionId }: Pick<Awaited<ReturnType<typeof auth>>, "userId" | "sessionId">,
	href: string,
): string {
	if (!userId || !sessionId) {
		throw redirect({ to: "/sign-in", search: { redirect_url: href } });
	}
	return JSON.stringify([userId, sessionId]);
}
