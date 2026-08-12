import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { env } from "@/lib/env";

export function createClerkRequestMiddleware() {
	return clerkMiddleware({
		publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
		signInUrl: "/sign-in",
		signUpUrl: "/sign-up",
	});
}
