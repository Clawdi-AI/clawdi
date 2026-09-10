import { createIsomorphicFn } from "@tanstack/react-start";
import { getResponseHeader } from "@tanstack/react-start/server";

export const readCspNonce = createIsomorphicFn()
	.server(() => {
		const policy = getResponseHeader("Content-Security-Policy");
		return typeof policy === "string" ? policy.match(/'nonce-([^']+)'/)?.[1] : undefined;
	})
	.client(() => document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content);
