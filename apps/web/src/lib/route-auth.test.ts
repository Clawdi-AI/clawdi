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
				headers: { "Cache-Control": "private, no-store" },
			});
	}
});

test("signed-out hosted homepage reloads the marketing root while public links use /home", () => {
	for (const [marketingUrl, marketingRoot] of [
		["https://clawdi.ai/home", "https://clawdi.ai/"],
		["https://marketing.example.test/home?from=cloud#public", "https://marketing.example.test/"],
		["https://marketing.example.test/", "https://marketing.example.test/"],
	]) {
		try {
			requireRouteIdentity({ userId: null, sessionId: null }, "/", marketingUrl);
			throw new Error("Expected a redirect");
		} catch (error) {
			expect(isRedirect(error)).toBe(true);
			if (isRedirect(error)) {
				expect(error.options).toMatchObject({
					href: marketingRoot,
					reloadDocument: true,
					headers: { "Cache-Control": "private, no-store" },
				});
			}
		}
	}
});

test("hosted deep links and OSS homepage keep their sign-in return destination", () => {
	for (const [href, marketingUrl] of [
		["/", undefined],
		["/dashboard", "https://clawdi.ai/home"],
		["/dashboard?deploy_profile=sui#overview", "https://clawdi.ai/home"],
		["/?settings=billing-wallet", "https://clawdi.ai/home"],
		["/#billing", "https://clawdi.ai/home"],
		["/agents?view=all", "https://clawdi.ai/home"],
		["/cli-authorize?user_code=ABCD", "https://clawdi.ai/home"],
		["/oauth/codex/callback?code=opaque&state=state", "https://clawdi.ai/home"],
	] as const) {
		try {
			requireRouteIdentity({ userId: null, sessionId: null }, href, marketingUrl);
			throw new Error("Expected a redirect");
		} catch (error) {
			expect(isRedirect(error)).toBe(true);
			if (isRedirect(error)) {
				expect(error.options).toMatchObject({
					to: "/sign-in",
					search: { redirect_url: href },
				});
			}
		}
	}
});

test("signed-in hosted homepage keeps the dashboard identity", () => {
	expect(requireRouteIdentity(signedIn, "/", "https://clawdi.ai/home")).toBe(
		JSON.stringify(["user-a", "session-a"]),
	);
});
