import { randomBytes } from "node:crypto";
import { createMiddleware } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

export const securityHeaders = createMiddleware().server(async ({ next }) => {
	const nonce = randomBytes(18).toString("base64");
	setResponseHeader(
		"Content-Security-Policy",
		[
			"default-src 'self'",
			`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
			"script-src-attr 'none'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob: https:",
			"font-src 'self' data: https:",
			"connect-src 'self' https: wss:",
			"frame-src https:",
			"worker-src 'self' blob:",
			"object-src 'none'",
			"base-uri 'self'",
			"frame-ancestors 'none'",
			"form-action 'self' https:",
		].join("; "),
	);
	setResponseHeader("X-Content-Type-Options", "nosniff");
	setResponseHeader("Referrer-Policy", "strict-origin-when-cross-origin");
	// A nonce-bearing document must not be shared across requests by a CDN.
	setResponseHeader("Cache-Control", "private, no-store");
	return next();
});
