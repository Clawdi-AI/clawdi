import type { useAuth, useClerk } from "@clerk/tanstack-react-start";
import { redirect } from "@tanstack/react-router";

export type RouteAuth =
	| { status: "loading" | "unavailable" | "signed-out" }
	| { status: "signed-in"; userId: string; sessionId: string };

export interface AppRouterContext {
	auth: RouteAuth | undefined;
}

export function routeAuthIdentity(auth: RouteAuth | undefined): string | null {
	return auth?.status === "signed-in" ? JSON.stringify([auth.userId, auth.sessionId]) : null;
}

export function resolveRouteAuth(
	auth: Pick<ReturnType<typeof useAuth>, "isLoaded" | "isSignedIn" | "userId" | "sessionId">,
	status: ReturnType<typeof useClerk>["status"],
): RouteAuth {
	if (status === "degraded" || status === "error") return { status: "unavailable" };
	if (status === "loading" || !auth.isLoaded) return { status: "loading" };
	if (!auth.isSignedIn || !auth.userId || !auth.sessionId) return { status: "signed-out" };
	return { status: "signed-in", userId: auth.userId, sessionId: auth.sessionId };
}

export class RouteAuthUnavailable extends Error {
	constructor(readonly status: "loading" | "unavailable") {
		super("Authentication is not ready");
	}
}

export function requireRouteIdentity(auth: RouteAuth | undefined, href: string): string {
	if (!auth || auth.status === "loading" || auth.status === "unavailable") {
		throw new RouteAuthUnavailable(auth?.status === "unavailable" ? "unavailable" : "loading");
	}
	const identity = routeAuthIdentity(auth);
	if (identity === null) {
		throw redirect({ to: "/sign-in", search: { redirect_url: href } });
	}
	return identity;
}
