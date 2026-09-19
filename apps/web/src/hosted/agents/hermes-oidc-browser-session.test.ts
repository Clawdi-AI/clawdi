import { afterEach, describe, expect, test } from "bun:test";
import { primeHermesOidcBrowserSession } from "./hermes-oidc-browser-session";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function capturingFetch(
	calls: Array<[string | URL | Request, RequestInit | undefined]>,
): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			calls.push([input, init]);
			return new Response(null, { status: 204 });
		},
		{ preconnect: originalFetch.preconnect },
	);
}

describe("primeHermesOidcBrowserSession", () => {
	test("posts the Clerk bearer with the exact deployment version", async () => {
		const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
		globalThis.fetch = capturingFetch(calls);
		await primeHermesOidcBrowserSession(
			"https://api.clawdi.ai/v2/deployments/hdep_test/hermes-oidc/session",
			"hdep_test",
			"https://api.clawdi.ai",
			"clerk-token",
			"rv-test",
			new AbortController().signal,
		);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call).toBeDefined();
		if (!call) throw new Error("Expected one fetch call.");
		const [url, init] = call;
		expect(String(url)).toBe("https://api.clawdi.ai/v2/deployments/hdep_test/hermes-oidc/session");
		expect(init?.credentials).toBe("include");
		expect(init?.headers).toEqual({
			Authorization: "Bearer clerk-token",
			"If-Match": '"rv-test"',
		});
	});

	test("rejects a session URL on another origin before sending the bearer", async () => {
		const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
		globalThis.fetch = capturingFetch(calls);
		await expect(
			primeHermesOidcBrowserSession(
				"https://attacker.example/v2/deployments/hdep_test/hermes-oidc/session",
				"hdep_test",
				"https://api.clawdi.ai",
				"clerk-token",
				"rv-test",
				new AbortController().signal,
			),
		).rejects.toThrow("Invalid Hermes browser session endpoint.");
		expect(calls).toHaveLength(0);
	});

	test("rejects a session URL for another deployment before fetching", async () => {
		const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
		globalThis.fetch = capturingFetch(calls);
		await expect(
			primeHermesOidcBrowserSession(
				"https://api.clawdi.ai/v2/deployments/hdep_other/hermes-oidc/session",
				"hdep_test",
				"https://api.clawdi.ai",
				"clerk-token",
				"rv-test",
				new AbortController().signal,
			),
		).rejects.toThrow("Invalid Hermes browser session endpoint.");
		expect(calls).toHaveLength(0);
	});
});
