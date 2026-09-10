import { expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";
import { requireRouteIdentity, resolveRouteAuth, routeAuthIdentity } from "./route-auth";

const signedIn = { isLoaded: true, isSignedIn: true, userId: "user-a", sessionId: "session-a" };

test("server admission and live identity agree, including same-user session changes", () => {
	const auth = resolveRouteAuth(signedIn, "ready");
	expect(requireRouteIdentity(signedIn, "/agents")).toBe(JSON.stringify(["user-a", "session-a"]));
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

test("unloaded auth and explicit SDK failures block private data despite an SSR snapshot", () => {
	for (const status of ["degraded", "error"] as const) {
		expect(resolveRouteAuth(signedIn, status)).toEqual({ status: "unavailable" });
	}
	expect(resolveRouteAuth({ ...signedIn, isLoaded: false }, "ready")).toEqual({
		status: "loading",
	});
});

test("signed-out server admission redirects with the destination", () => {
	try {
		requireRouteIdentity({ userId: null, sessionId: null }, "/agents?view=all");
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
