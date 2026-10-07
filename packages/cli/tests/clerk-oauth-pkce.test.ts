import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	createClerkOAuthAuthorization,
	exactLoopbackRedirectUri,
	exchangeClerkOAuthCode,
	fetchClerkOAuthPkceDiscovery,
	parseClerkOAuthCallback,
} from "../src/lib/clerk-oauth";
import { startClerkOAuthLoopback } from "../src/lib/clerk-oauth-loopback";

const redirectUri = "http://127.0.0.1:18473/oauth/callback";
const config = { issuer: "https://clerk.example.test", clientId: "clawdi-cli", redirectUri };
const discovery = {
	issuer: config.issuer,
	authorizationEndpoint: `${config.issuer}/oauth/authorize`,
	tokenEndpoint: `${config.issuer}/oauth/token`,
};
function authorization() {
	return createClerkOAuthAuthorization({
		config,
		discovery,
		apiUrl: "https://api.example.test",
		hostedApiUrl: "https://deploy.example.test",
	});
}
function callback(state: string, values: Record<string, string> = { code: "private-code" }) {
	const url = new URL(redirectUri);
	url.search = new URLSearchParams({ state, ...values }).toString();
	return url.href;
}

test("Desktop creates fresh state and an S256 challenge with the registered redirect", () => {
	const pending = authorization();
	const next = authorization();
	const url = new URL(pending.authorizationUrl);
	expect(pending.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
	expect(next.state).not.toBe(pending.state);
	expect(next.codeVerifier).not.toBe(pending.codeVerifier);
	expect(Object.fromEntries(url.searchParams)).toEqual({
		response_type: "code",
		client_id: config.clientId,
		redirect_uri: redirectUri,
		scope: "openid profile email offline_access",
		state: pending.state,
		code_challenge: createHash("sha256").update(pending.codeVerifier).digest("base64url"),
		code_challenge_method: "S256",
	});
	expect(pending.authorizationUrl).not.toContain(pending.codeVerifier);
});

test.each([
	undefined,
	"http://localhost:18473/oauth/callback",
	"http://127.0.0.1:1234/oauth/callback",
	"http://127.0.0.1:18473/oauth/callback?state=bad",
	"http://127.0.0.1:18473/oauth/callback#bad",
	"http://user@127.0.0.1:18473/oauth/callback",
	"https://remote.test/oauth/callback",
])("rejects unregistered or decorated redirects: %s", (raw) => {
	expect(() => exactLoopbackRedirectUri(raw)).toThrow("registered OAuth redirect");
});

test("PKCE discovery needs S256 and a public authorization-code client, independently of device grant", async () => {
	const body = {
		issuer: config.issuer,
		authorization_endpoint: discovery.authorizationEndpoint,
		token_endpoint: discovery.tokenEndpoint,
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
	};
	expect(
		await fetchClerkOAuthPkceDiscovery(config, { fetch: async () => Response.json(body) }),
	).toEqual(discovery);
	for (const overrides of [
		{ code_challenge_methods_supported: ["plain"] },
		{ token_endpoint_auth_methods_supported: ["client_secret_basic"] },
		{ authorization_endpoint: "https://attacker.test/authorize" },
		{ grant_types_supported: ["refresh_token"] },
	]) {
		await expect(
			fetchClerkOAuthPkceDiscovery(config, {
				fetch: async () => Response.json({ ...body, ...overrides }),
			}),
		).rejects.toThrow();
	}
});

test("validates callback state and origin, rejects duplicates, and maps access_denied", () => {
	const pending = authorization();
	expect(parseClerkOAuthCallback(pending, callback(pending.state))).toBe("private-code");
	for (const url of [
		callback("wrong"),
		callback(pending.state).replace("127.0.0.1", "localhost"),
		`${callback(pending.state)}&state=${pending.state}`,
		`${callback(pending.state)}&code=second`,
		`${callback(pending.state)}#fragment`,
		callback(pending.state, {}),
		callback(pending.state, { code: "code", error: "access_denied" }),
	]) {
		expect(() => parseClerkOAuthCallback(pending, url)).toThrow("callback");
	}
	expect(() =>
		parseClerkOAuthCallback(pending, callback(pending.state, { error: "access_denied" })),
	).toThrow("cancelled");
});

test("exchanges the code with the verifier and no client secret, preserving endpoint binding", async () => {
	const pending = authorization();
	let form: URLSearchParams | undefined;
	const auth = await exchangeClerkOAuthCode(pending, callback(pending.state), {
		fetch: async (request) => {
			expect(request.url).toBe(discovery.tokenEndpoint);
			expect(request.redirect).toBe("error");
			expect(request.headers.has("Authorization")).toBe(false);
			form = new URLSearchParams(await request.text());
			return Response.json({
				access_token: "opaque-access",
				refresh_token: "private-refresh",
				token_type: "Bearer",
				expires_in: 3600,
			});
		},
	});
	expect(form && Object.fromEntries(form)).toEqual({
		grant_type: "authorization_code",
		client_id: config.clientId,
		redirect_uri: redirectUri,
		code: "private-code",
		code_verifier: pending.codeVerifier,
	});
	expect(auth.endpointBinding).toEqual(pending.endpointBinding);
	const fetcher = mock(async (_request: Request) => Response.json({}));
	await expect(
		exchangeClerkOAuthCode(
			{ ...pending, expiresAt: new Date(0).toISOString() },
			callback(pending.state),
			{ fetch: fetcher },
		),
	).rejects.toThrow("expired");
	await expect(
		exchangeClerkOAuthCode(pending, callback("wrong"), { fetch: fetcher }),
	).rejects.toThrow("validation");
	expect(fetcher).not.toHaveBeenCalled();
});

test("loopback ignores wrong state and paths, accepts one callback without reflecting code", async () => {
	const pending = authorization();
	const loopback = await startClerkOAuthLoopback(redirectUri, pending.state);
	try {
		expect((await fetch(`${redirectUri}/other`)).status).toBe(404);
		expect((await fetch(callback("wrong"))).status).toBe(400);
		expect((await fetch(`${callback(pending.state)}&state=${pending.state}`)).status).toBe(400);
		const response = await fetch(callback(pending.state));
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).not.toContain("private-code");
		expect(await loopback.callbackUrl).toBe(callback(pending.state));
	} finally {
		await loopback.close();
	}
	await expect(fetch(callback(pending.state))).rejects.toThrow();
});

test("loopback denial, timeout, cancellation and port conflict all release the listener", async () => {
	const pending = authorization();
	const denied = await startClerkOAuthLoopback(redirectUri, pending.state);
	try {
		const response = await fetch(callback(pending.state, { error: "access_denied" }));
		expect(response.status).toBe(400);
		expect(() =>
			parseClerkOAuthCallback(pending, callback(pending.state, { error: "access_denied" })),
		).toThrow("cancelled");
		expect(await denied.callbackUrl).toBe(callback(pending.state, { error: "access_denied" }));
	} finally {
		await denied.close();
	}
	const timedOut = await startClerkOAuthLoopback(redirectUri, pending.state, { timeoutMs: 50 });
	try {
		await expect(timedOut.callbackUrl).rejects.toThrow("timed out");
	} finally {
		await timedOut.close();
	}
	const controller = new AbortController();
	const cancelled = await startClerkOAuthLoopback(redirectUri, pending.state, {
		signal: controller.signal,
	});
	try {
		await expect(startClerkOAuthLoopback(redirectUri, pending.state)).rejects.toThrow(
			"Close the other Clawdi sign-in",
		);
		controller.abort();
		await expect(cancelled.callbackUrl).rejects.toThrow("cancelled");
	} finally {
		await cancelled.close();
	}
	const reopened = await startClerkOAuthLoopback(redirectUri, pending.state);
	await reopened.close();
});
