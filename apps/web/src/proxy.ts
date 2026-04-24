import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Protection is "everything not on this list". A positive-allowlist for
// protected routes would default new pages to PUBLIC if someone forgets
// to update it — the opposite of what we want for a dashboard. Keep
// this as the narrow public carve-outs.
//
// `/skill.md` must be publicly reachable — fresh AI agents fetch it during
// the "Send to Agent" onboarding flow and have no Clerk session yet.
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/skill.md"]);

export default clerkMiddleware(async (auth, request) => {
	if (!isPublicRoute(request)) {
		await auth.protect();
	}
});

export const config = {
	matcher: [
		"/((?!_next|[^?]*\\.(?:html?|md|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		"/(api|trpc)(.*)",
	],
};
