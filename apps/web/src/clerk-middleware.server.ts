import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createMiddleware } from "@tanstack/react-start";
import { env } from "@/lib/env";

export function createClerkRequestMiddleware() {
	const clerk = clerkMiddleware({
		publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
		signInUrl: "/sign-in",
		signUpUrl: "/sign-up",
	});
	const authenticate = clerk.options.server;
	if (!authenticate) throw new Error("Clerk request middleware has no server handler");

	return createMiddleware().server((options) => {
		// Public association/discovery files must never enter Clerk's handshake.
		if (options.pathname.startsWith("/.well-known/")) return options.next();
		return authenticate(options);
	});
}
