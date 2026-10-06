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
import { getRequest } from "@tanstack/react-start/server";
import { createClerkRequestMiddleware } from "@/clerk-middleware.server";
import { env } from "@/lib/env";
import { securityHeaders } from "@/security-headers.server";

const getClerkRequestMiddleware = createIsomorphicFn()
	.client(() => undefined)
	.server(() => createClerkRequestMiddleware());

const getSecurityHeaders = createIsomorphicFn()
	.client(() => undefined)
	.server(() => securityHeaders);

const isWellKnownRequest = createIsomorphicFn()
	.client(() => false)
	.server(() => new URL(getRequest().url).pathname.startsWith("/.well-known/"));

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

const clerkRequestMiddleware =
	!env.VITE_DEV_AUTH_BYPASS && !env.VITE_CLAWDI_DESKTOP_BUILD
		? getClerkRequestMiddleware()
		: undefined;

export const startInstance = createStart(() => ({
	// Association/discovery files must never enter Clerk's handshake redirects.
	requestMiddleware: [
		...requestMiddleware,
		...(!isWellKnownRequest() && clerkRequestMiddleware ? [clerkRequestMiddleware] : []),
		csrfMiddleware,
	],
	functionMiddleware: env.VITE_SENTRY_DSN ? [sentryGlobalFunctionMiddleware] : [],
}));
