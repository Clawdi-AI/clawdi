import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isHostedBuild = process.env.NEXT_PUBLIC_CLAWDI_HOSTED === "true";

// Protection is "everything not on this list". A positive-allowlist for
// protected routes would default new pages to PUBLIC if someone forgets
// to update it — the opposite of what we want for a dashboard. Keep
// this as the narrow public carve-outs.
//
// `/skill.md` must be publicly reachable — fresh AI agents fetch it during
// the "Send to Agent" onboarding flow and have no Clerk session yet.
//
// `/s/(.*)` covers the public session-share routes: the HTML page at
// `/s/{token}`, the `.md` / `.json` formats served by the format route
// handler, and the `next.config.ts` rewrites that land between them.
// The matcher above already lets `.md` URLs through (extension carve-out)
// but explicitly carves `.json` *out* of the `.js` exclusion, so without
// this entry `/s/{token}.json` would 307 to /sign-in. Share access is
// gated by the token, not the user's Clerk session.
//
// `/share/*` is the public landing page for shared scopes; anonymous
// previews + sign-in handoff happen there.
const publicRoutes = [
	"/sign-in(.*)",
	"/sign-up(.*)",
	"/skill.md",
	"/s/(.*)",
	"/share/(.*)",
];

if (isHostedBuild) {
	// PostHog first-party proxy path is hosted-only.
	publicRoutes.push("/_cdi/px(.*)");
}

const isPublicRoute = createRouteMatcher(publicRoutes);

// signInUrl / signUpUrl must live here — they tell auth.protect() where
// to send unauth'd users. Without them, Clerk falls back to its hosted
// page at <instance>.accounts.dev/sign-in, not our in-app /sign-in.
// Middleware runs outside the React tree, so ClerkProvider props don't
// reach it; the config lives on the middleware call itself.
export default clerkMiddleware(
	async (auth, request) => {
		if (!isPublicRoute(request)) {
			await auth.protect();
		}
	},
	{ signInUrl: "/sign-in", signUpUrl: "/sign-up" },
);

export const config = {
	matcher: [
		"/((?!_next|[^?]*\\.(?:html?|md|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		"/(api|trpc)(.*)",
	],
};
