import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Explicit allowlist. Anything outside this set is protected by Clerk.
// `/skill.md` must be publicly reachable — fresh AI agents fetch it during
// the "Send to Agent" onboarding flow and have no Clerk session yet.
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/skill.md"]);

// Dashboard and API paths that must be authenticated. Keeping this as a
// positive matcher (in addition to the "else protect" default) is both
// self-documenting and a safety net if someone changes the matcher config
// below in a way that exposes routes.
const isProtectedRoute = createRouteMatcher([
	"/",
	"/sessions(.*)",
	"/memories(.*)",
	"/skills(.*)",
	"/vault(.*)",
	"/connectors(.*)",
	"/settings(.*)",
	"/api/(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
	if (isPublicRoute(request)) return;
	if (isProtectedRoute(request)) {
		await auth.protect();
	}
});

export const config = {
	matcher: [
		"/((?!_next|[^?]*\\.(?:html?|md|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		"/(api|trpc)(.*)",
	],
};
