/** Establish and verify the separately scoped runtime-origin recovery cookie. */
export async function primeOpenClawBrowserSession(
	url: string,
	endpoint: string,
	token: string,
	resourceVersion: string,
	signal: AbortSignal,
): Promise<void> {
	const expected = new URL(".well-known/openclaw/browser-session", endpoint);
	if (
		expected.protocol !== "https:" ||
		expected.href !== url ||
		expected.pathname !== "/.well-known/openclaw/browser-session"
	) {
		throw new Error("Invalid browser session endpoint.");
	}
	const options = {
		credentials: "include",
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
	} as const;
	const bootstrap = await fetch(url, {
		...options,
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "If-Match": `"${resourceVersion}"` },
	});
	if (bootstrap.status !== 204) throw new Error("Browser session could not be established.");
	// Set-Cookie is not observable by JavaScript. Verify delivery with a request
	// that has only the browser's cookie, before loading the official document.
	const verified = await fetch(url, { ...options, method: "HEAD" });
	if (verified.status !== 204) throw new Error("Browser session cookie is unavailable.");
}
