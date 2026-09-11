import {
	sentryGlobalFunctionMiddleware,
	sentryGlobalRequestMiddleware,
} from "@sentry/tanstackstart-react";
import {
	type AnyRequestMiddleware,
	createCsrfMiddleware,
	createIsomorphicFn,
	createStart,
} from "@tanstack/react-start";
import { createClerkRequestMiddleware } from "@/clerk-middleware.server";
import { env } from "@/lib/env";
import { securityHeaders } from "@/security-headers.server";

const getClerkRequestMiddleware = createIsomorphicFn()
	.client(() => undefined)
	.server(() => createClerkRequestMiddleware());

const getSecurityHeaders = createIsomorphicFn()
	.client(() => undefined)
	.server(() => securityHeaders);

const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

const requestMiddleware: AnyRequestMiddleware[] = [];

if (import.meta.env.PROD && !env.VITE_CLAWDI_DESKTOP_BUILD) {
	const middleware = getSecurityHeaders();
	if (middleware) requestMiddleware.push(middleware);
}

if (env.VITE_SENTRY_DSN) {
	requestMiddleware.push(sentryGlobalRequestMiddleware);
}

if (!env.VITE_DEV_AUTH_BYPASS && !env.VITE_CLAWDI_DESKTOP_BUILD) {
	const clerkRequestMiddleware = getClerkRequestMiddleware();
	if (clerkRequestMiddleware) requestMiddleware.push(clerkRequestMiddleware);
}

requestMiddleware.push(csrfMiddleware);

export const startInstance = createStart(() => ({
	requestMiddleware,
	functionMiddleware: env.VITE_SENTRY_DSN ? [sentryGlobalFunctionMiddleware] : [],
}));
