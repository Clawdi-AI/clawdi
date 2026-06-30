import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import {
	type AnyRequestMiddleware,
	createCsrfMiddleware,
	createStart,
} from "@tanstack/react-start";
import { env } from "@/lib/env";

const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

const requestMiddleware: AnyRequestMiddleware[] = [csrfMiddleware];

if (!env.VITE_DEV_AUTH_BYPASS) {
	requestMiddleware.unshift(
		clerkMiddleware({
			publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
			signInUrl: "/sign-in",
			signUpUrl: "/sign-up",
		}),
	);
}

export const startInstance = createStart(() => ({
	requestMiddleware,
}));
