import { describe, expect, test } from "bun:test";
import {
	FilesAssertionCache,
	type FilesForwardAuthDependencies,
	GET,
} from "./files-forward-auth-route";

const DASHBOARD_ORIGIN = "https://cloud.clawdi.ai";
const FILES_HOST = "abc-9120.prod12.clawdi.ai";
const ROUTE_PROOF = "a".repeat(64);
const SESSION_TOKEN = "clerk-session-token";
const ASSERTION = "files-assertion.".padEnd(96, "x");
const NOW = Date.parse("2026-08-05T00:00:00Z");

function forwardAuthRequest(
	overrides: { url?: string; host?: string; uri?: string; proof?: string } = {},
): Request {
	return new Request(
		overrides.url ?? `${DASHBOARD_ORIGIN}/api/files/forward-auth?deployment_id=42`,
		{
			headers: {
				"X-Forwarded-Host": overrides.host ?? FILES_HOST,
				"X-Forwarded-Proto": "https",
				"X-Forwarded-Uri": overrides.uri ?? "/files/deep?sort=name",
				"X-Clawdi-Files-Route-Proof": overrides.proof ?? ROUTE_PROOF,
				Cookie: "__session=opaque",
			},
		},
	);
}

function dependencies(
	input: {
		signedOut?: boolean;
		sessionToken?: string;
		brokerStatus?: number;
		inspectFetch?: (url: string, init?: RequestInit) => void;
		assertionCache?: FilesAssertionCache;
	} = {},
): FilesForwardAuthDependencies {
	return {
		getToken: async () => (input.signedOut ? null : (input.sessionToken ?? SESSION_TOKEN)),
		fetch: async (resource, init) => {
			input.inspectFetch?.(resource, init);
			return Response.json(
				{
					assertion: ASSERTION,
					expires_at: new Date(NOW + 30_000).toISOString(),
				},
				{ status: input.brokerStatus ?? 200 },
			);
		},
		deployApiUrl: "https://api.clawdi.ai",
		assertionCache: input.assertionCache ?? new FilesAssertionCache(),
		now: () => NOW,
	};
}

describe("Files ForwardAuth", () => {
	test("returns only the assertion from the owner broker", async () => {
		let backendAuthorization = "";
		const response = await GET(
			forwardAuthRequest(),
			dependencies({
				inspectFetch: (url, init) => {
					expect(url).toBe("https://api.clawdi.ai/v2/deployments/42/files/assertion");
					expect(url).not.toContain(SESSION_TOKEN);
					const headers = new Headers(init?.headers);
					backendAuthorization = headers.get("Authorization") ?? "";
					expect(headers.get("X-Clawdi-Files-Host")).toBe(FILES_HOST);
					expect(headers.get("X-Clawdi-Files-Uri")).toBe("/files/deep?sort=name");
					expect(headers.get("X-Clawdi-Files-Route-Proof")).toBe(ROUTE_PROOF);
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-JWT-Assertion")).toBe(ASSERTION);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(backendAuthorization).toBe(`Bearer ${SESSION_TOKEN}`);
	});

	test("coalesces asset bursts and reuses one short-lived broker assertion", async () => {
		let brokerRequests = 0;
		const shared = dependencies({
			inspectFetch: () => {
				brokerRequests += 1;
			},
		});
		const responses = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				GET(forwardAuthRequest({ uri: `/static/asset-${index}.js` }), shared),
			),
		);
		expect(responses.every((response) => response.status === 200)).toBe(true);
		expect(brokerRequests).toBe(1);

		await GET(forwardAuthRequest({ uri: "/api/resources" }), shared);
		expect(brokerRequests).toBe(1);
	});

	test("misses the cache when the session or access-revision proof changes", async () => {
		let brokerRequests = 0;
		const assertionCache = new FilesAssertionCache();
		const first = dependencies({
			assertionCache,
			inspectFetch: () => {
				brokerRequests += 1;
			},
		});
		const otherSession = dependencies({
			assertionCache,
			sessionToken: "other-session",
			inspectFetch: () => {
				brokerRequests += 1;
			},
		});
		await GET(forwardAuthRequest(), first);
		await GET(forwardAuthRequest(), otherSession);
		await GET(forwardAuthRequest({ proof: "b".repeat(64) }), first);
		expect(brokerRequests).toBe(3);
	});

	test("bounds concurrent misses as well as completed cache entries", async () => {
		const assertionCache = new FilesAssertionCache(1);
		let releaseFirst:
			| ((value: { assertion: string; expiresAtMilliseconds: number }) => void)
			| undefined;
		const first = assertionCache.getOrLoad(
			"first",
			NOW,
			() =>
				new Promise((resolve) => {
					releaseFirst = resolve;
				}),
		);

		await expect(
			assertionCache.getOrLoad("second", NOW, async () => ({
				assertion: ASSERTION,
				expiresAtMilliseconds: NOW + 30_000,
			})),
		).rejects.toThrow("Files assertion cache is at capacity");

		releaseFirst?.({
			assertion: ASSERTION,
			expiresAtMilliseconds: NOW + 30_000,
		});
		await expect(first).resolves.toEqual({
			assertion: ASSERTION,
			expiresAtMilliseconds: NOW + 30_000,
		});
	});

	test("redirects signed-out standalone requests through the current cloud route", async () => {
		const response = await GET(forwardAuthRequest(), dependencies({ signedOut: true }));

		expect(response.status).toBe(302);
		const location = response.headers.get("Location") ?? "";
		expect(location).toStartWith(`${DASHBOARD_ORIGIN}/sign-in?`);
		const redirectUrl = new URL(location).searchParams.get("redirect_url");
		expect(redirectUrl).toBe(
			"/api/files/authorize?deployment_id=42&return_to=%2Ffiles%2Fdeep%3Fsort%3Dname",
		);
		expect(location).not.toContain("www.clawdi.ai");
		expect(location).not.toContain(SESSION_TOKEN);
	});

	test("fails visibly inside an iframe instead of loading Clerk there", async () => {
		const base = forwardAuthRequest();
		const headers = new Headers(base.headers);
		headers.set("Sec-Fetch-Dest", "iframe");
		const response = await GET(
			new Request(base.url, { headers }),
			dependencies({ signedOut: true }),
		);

		expect(response.status).toBe(403);
		expect(response.headers.get("Location")).toBeNull();
		expect(await response.text()).toContain("Sign in with the Clawdi account");
	});

	test("fails closed on route proof, host, target, and broker ownership failures", async () => {
		expect((await GET(forwardAuthRequest({ proof: "client-value" }), dependencies())).status).toBe(
			403,
		);
		expect(
			(await GET(forwardAuthRequest({ uri: "//attacker.example/path" }), dependencies())).status,
		).toBe(403);
		const ownershipFailure = await GET(
			forwardAuthRequest({ host: "abc-9120.attacker.example" }),
			dependencies({ brokerStatus: 403 }),
		);
		expect(ownershipFailure.status).toBe(403);
		expect(await ownershipFailure.text()).toContain("Clawdi account that owns this agent");
		expect(ownershipFailure.headers.get("Cache-Control")).toContain("no-store");
	});
});
