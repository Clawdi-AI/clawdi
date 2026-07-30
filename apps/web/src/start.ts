import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import {
	sentryGlobalFunctionMiddleware,
	sentryGlobalRequestMiddleware,
} from "@sentry/tanstackstart-react";
import {
	type AnyRequestMiddleware,
	createCsrfMiddleware,
	createStart,
} from "@tanstack/react-start";
import { env } from "@/lib/env";

const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

const requestMiddleware: AnyRequestMiddleware[] = [];

if (env.VITE_SENTRY_DSN) {
	requestMiddleware.push(sentryGlobalRequestMiddleware);
}

if (!env.VITE_DEV_AUTH_BYPASS) {
	requestMiddleware.push(
		clerkMiddleware({
			publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
			signInUrl: "/sign-in",
			signUpUrl: "/sign-up",
		}),
	);
}

requestMiddleware.push(csrfMiddleware);

export const startInstance = createStart(() => ({
	requestMiddleware,
	functionMiddleware: env.VITE_SENTRY_DSN ? [sentryGlobalFunctionMiddleware] : [],
}));
