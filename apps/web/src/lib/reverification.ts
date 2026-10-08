/** Clerk's documented strict preset: second factor (first-factor fallback), 10 minutes. */
export const STRICT_REVERIFICATION_ERROR = {
	clerk_error: {
		type: "forbidden",
		reason: "reverification-error",
		metadata: { reverification: "strict" },
	},
} as const;

export function requiresCloudReverification(method: string, path: string): boolean {
	return ["GET", "POST", "DELETE"].includes(method) && /^\/v1\/auth\/keys(?:\/[^/]+)?$/.test(path);
}

/** These Hosted mutations need the same server-side fva gate in the Hosted repo. */
export function requiresHostedReverification(method: string, path: string): boolean {
	if (method === "PUT" && path === "/v2/wallet/auto-reload") return true;
	return (
		method === "POST" &&
		[
			"/v2/wallet/auto-reload/setup-intent",
			"/v2/wallet/auto-reload/setup-intent/finalize",
			"/v2/wallet/topup",
			"/v2/subscription/plan/change",
			"/v2/subscription/plan/cancel-scheduled-change",
			"/v2/subscription/fix-payment",
			"/v2/subscription/portal",
			"/v2/subscription/checkout",
		].includes(path)
	);
}
