import { expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";
import {
	RouteAuthUnavailable,
	requireRouteIdentity,
	resolveRouteAuth,
	routeAuthIdentity,
} from "./route-auth";

const signedIn = { isLoaded: true, isSignedIn: true, userId: "user-a", sessionId: "session-a" };

test("admission uses a loaded live session, including same-user session changes", () => {
	const auth = resolveRouteAuth(signedIn, "ready");
	expect(requireRouteIdentity(auth, "/agents")).toBe(JSON.stringify(["user-a", "session-a"]));
	expect(
		routeAuthIdentity(resolveRouteAuth({ ...signedIn, sessionId: "session-b" }, "ready")),
	).not.toBe(routeAuthIdentity(auth));
	expect(routeAuthIdentity(resolveRouteAuth({ ...signedIn, userId: "user-b" }, "ready"))).not.toBe(
		routeAuthIdentity(auth),
	);
});

test("native authenticated SSR state admits during SDK bootstrap", () => {
	expect(resolveRouteAuth(signedIn, "loading")).toEqual(resolveRouteAuth(signedIn, "ready"));
});

test("unknown auth and explicit SDK failures never admit, even with a signed-in SSR snapshot", () => {
	for (const status of ["degraded", "error"] as const) {
		expect(() => requireRouteIdentity(resolveRouteAuth(signedIn, status), "/agents")).toThrow(
			RouteAuthUnavailable,
		);
	}
	expect(() => requireRouteIdentity(undefined, "/agents")).toThrow(RouteAuthUnavailable);
	for (const status of ["loading", "ready"] as const) {
		expect(() =>
			requireRouteIdentity(resolveRouteAuth({ ...signedIn, isLoaded: false }, status), "/agents"),
		).toThrow(RouteAuthUnavailable);
	}
});

test("signed-out and Clerk's default pending-as-signed-out result redirect with the destination", () => {
	const auth = resolveRouteAuth(
		{ isLoaded: true, isSignedIn: false, userId: null, sessionId: null },
		"ready",
	);
	try {
		requireRouteIdentity(auth, "/agents?view=all");
		throw new Error("Expected a redirect");
	} catch (error) {
		expect(isRedirect(error)).toBe(true);
		if (isRedirect(error))
			expect(error.options).toMatchObject({
				to: "/sign-in",
				search: { redirect_url: "/agents?view=all" },
			});
	}
});
