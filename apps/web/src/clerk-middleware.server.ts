import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createMiddleware } from "@tanstack/react-start";
import { APP_LINK_ASSOCIATION_PATHS } from "@/lib/app-link-paths";
import { env } from "@/lib/env";

export function createClerkRequestMiddleware() {
	const clerk = clerkMiddleware({
		publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
		signInUrl: "/sign-in",
		signUpUrl: "/sign-up",
	});
	const authenticate = clerk.options.server;
	if (!authenticate) throw new Error("Clerk request middleware has no server handler");
	if (clerk.options.middleware) throw new Error("Clerk request middleware has nested middleware");

	return createMiddleware().server((options) => {
		if (APP_LINK_ASSOCIATION_PATHS.has(options.pathname)) return options.next();
		return authenticate(options);
	});
}
