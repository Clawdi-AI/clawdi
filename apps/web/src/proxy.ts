import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Protection is "everything not on this list". A positive-allowlist for
// protected routes would default new pages to PUBLIC if someone forgets
// to update it — the opposite of what we want for a dashboard. Keep
// this as the narrow public carve-outs.
//
// `/skill.md` must be publicly reachable — fresh AI agents fetch it during
// the "Send to Agent" onboarding flow and have no Clerk session yet.
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/skill.md"]);

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
