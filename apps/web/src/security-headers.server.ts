import { randomBytes } from "node:crypto";
import { createMiddleware } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { AGENT_FILES } from "@/lib/agent-files";
import { APP_LINK_ASSOCIATION_PATHS } from "@/lib/app-link-paths";

const commonSecurityHeaders = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
};

export const securityHeaders = createMiddleware().server(async ({ request, next }) => {
	for (const [name, value] of Object.entries(commonSecurityHeaders)) {
		setResponseHeader(name, value);
	}

	// Public machine-readable files do not contain HTML or request-specific nonces.
	const pathname = new URL(request.url).pathname;
	if (
		(request.method === "GET" || request.method === "HEAD") &&
		(APP_LINK_ASSOCIATION_PATHS.has(pathname) ||
			Object.values(AGENT_FILES).some((file) => file.path === pathname))
	) {
		const result = await next();
		// Start does not merge contextual headers into redirect responses.
		for (const [name, value] of Object.entries(commonSecurityHeaders)) {
			result.response.headers.set(name, value);
		}
		return result;
	}

	const nonce = randomBytes(18).toString("base64");
	setResponseHeader(
		"Content-Security-Policy",
		[
			"default-src 'self'",
			`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
			"script-src-attr 'none'",
			"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
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
	// A nonce-bearing document must not be shared across requests by a CDN.
	setResponseHeader("Cache-Control", "private, no-store");
	return next();
});
