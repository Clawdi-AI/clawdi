import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClerkOAuthClientConfig,
	type ClerkOAuthDiscovery,
	ClerkOAuthError,
	captureStoredCredentialIdentity,
	commitClawdiCredential,
	createClerkOAuthAuthorization,
	exchangeClerkOAuthCode,
	fetchClerkOAuthClientConfig,
	fetchClerkOAuthDiscovery,
	getClawdiAccessToken,
	logoutClawdiCredentials,
	revokeClerkOAuthSession,
	verifyAndPersistClerkOAuthLogin,
} from "../src/lib/clerk-oauth";
import { startClerkOAuthLoopback } from "../src/lib/clerk-oauth-loopback";
import {
	type ClerkOAuthAuth,
	clearAuth,
	getAuth,
	getStoredAuth,
	type PendingAuth,
	setAuth,
	setPendingAuth,
} from "../src/lib/config";

const NOW = Date.parse("2026-07-28T00:00:00Z");
const AUTHORIZED_PARTY = "https://accounts.clawdi.test";
const CLOUD_API_URL = "https://cloud.example.test";
const HOSTED_API_URL = "https://deploy.example.test";
const CONFIG: ClerkOAuthClientConfig = {
	issuer: "https://clerk.example.test",
	clientId: "clawdi-cli",
	audience: "clawdi-api",
	authorizedParties: [AUTHORIZED_PARTY],
	redirectUri: "http://127.0.0.1:18473/oauth/callback",
};
const DISCOVERY: ClerkOAuthDiscovery = {
	issuer: CONFIG.issuer,
	authorizationEndpoint: `${CONFIG.issuer}/oauth/authorize`,
	tokenEndpoint: `${CONFIG.issuer}/oauth/token`,
};

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function accessToken(overrides: Record<string, unknown> = {}): string {
	return `${encode({ alg: "RS256", typ: "at+jwt" })}.${encode({
		iss: CONFIG.issuer,
		client_id: CONFIG.clientId,
		aud: CONFIG.audience,
		azp: AUTHORIZED_PARTY,
		sub: "user_same_sub",
		iat: Math.floor(NOW / 1_000),
		exp: Math.floor(NOW / 1_000) + 3_600,
		...overrides,
	})}.signature`;
}

function storedOAuth(overrides: Partial<ClerkOAuthAuth> = {}): ClerkOAuthAuth {
	return {
		authType: "clerk_oauth",
		apiKey: accessToken({ exp: Math.floor(NOW / 1_000) - 1 }),
		refreshToken: "refresh-old",
		accessTokenExpiresAt: new Date(NOW - 1_000).toISOString(),
		issuer: CONFIG.issuer,
		clientId: CONFIG.clientId,
		audience: CONFIG.audience,
		tokenEndpoint: DISCOVERY.tokenEndpoint,
		scopes: ["openid", "profile", "email"],
		subject: "user_same_sub",
		userId: "cloud-local-user",
		endpointBinding: {
			version: 1,
			cloudApiOrigin: CLOUD_API_URL,
			hostedApiOrigin: HOSTED_API_URL,
		},
		...overrides,
	};
}

function pending(): PendingAuth {
	return {
		authType: "clerk_oauth_pkce",
		state: "state-value",
		codeVerifier: "verifier-value",
		authorizationUrl: `${DISCOVERY.authorizationEndpoint}?state=state-value`,
		redirectUri: CONFIG.redirectUri,
		issuer: CONFIG.issuer,
		clientId: CONFIG.clientId,
		audience: CONFIG.audience,
		authorizedParties: CONFIG.authorizedParties,
		tokenEndpoint: DISCOVERY.tokenEndpoint,
		expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
		apiUrl: CLOUD_API_URL,
		endpointBinding: {
			version: 1,
			cloudApiOrigin: CLOUD_API_URL,
			hostedApiOrigin: HOSTED_API_URL,
		},
		scopes: ["openid", "profile", "email", "offline_access"],
	};
}

function tokenResponse(token: string, refreshToken = "refresh-new"): Response {
	return Response.json({
		access_token: token,
		refresh_token: refreshToken,
		token_type: "Bearer",
		scope: "openid profile email offline_access",
	});
}

let priorClawdiHome: string | undefined;
let priorAuthToken: string | undefined;
let stateDir: string;

beforeEach(() => {
	priorClawdiHome = process.env.CLAWDI_HOME;
	priorAuthToken = process.env.CLAWDI_AUTH_TOKEN;
	delete process.env.CLAWDI_AUTH_TOKEN;
	stateDir = join(tmpdir(), `clawdi-oauth-${crypto.randomUUID()}`);
	mkdirSync(stateDir, { recursive: true });
	process.env.CLAWDI_HOME = stateDir;
});

afterEach(() => {
	if (priorClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = priorClawdiHome;
	if (priorAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
	else process.env.CLAWDI_AUTH_TOKEN = priorAuthToken;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("Clerk public OAuth PKCE", () => {
	test("loads optional audience and independent authorized-party origins", async () => {
		const config = await fetchClerkOAuthClientConfig("https://cloud.example.test", {
			fetch: async () =>
				Response.json({
					issuer: CONFIG.issuer,
					client_id: CONFIG.clientId,
					audience: "",
					authorized_parties: [`${AUTHORIZED_PARTY}/`, "https://BÜCHER.example:443/"],
					redirect_uri: CONFIG.redirectUri,
				}),
		});
		expect(config).toEqual({
			...CONFIG,
			audience: "",
			authorizedParties: [AUTHORIZED_PARTY, "https://xn--bcher-kva.example"],
		});
	});

	test("requires the registered /oauth/callback loopback path", async () => {
		await expect(
			fetchClerkOAuthClientConfig("https://cloud.example.test", {
				fetch: async () =>
					Response.json({
						issuer: CONFIG.issuer,
						client_id: CONFIG.clientId,
						audience: "",
						authorized_parties: [],
						redirect_uri: "http://127.0.0.1:18473/callback",
					}),
			}),
		).rejects.toThrow("/oauth/callback");
	});

	test.each([
		"https://bad_host.example.test",
		"https://-bad.example.test",
		"https://accounts.example.test.",
		"https://accounts.example.test?",
		"https://accounts.example.test#",
	])("rejects an invalid authorized-party origin %s", async (authorizedParty) => {
		await expect(
			fetchClerkOAuthClientConfig("https://cloud.example.test", {
				fetch: async () =>
					Response.json({
						issuer: CONFIG.issuer,
						client_id: CONFIG.clientId,
						audience: CONFIG.audience,
						authorized_parties: [authorizedParty],
						redirect_uri: CONFIG.redirectUri,
					}),
			}),
		).rejects.toThrow("authorized party");
	});

	test.each([
		["https://Clerk.Example.test", "https://clerk.example.test"],
		["https://Clerk.Example.test:443/", "https://clerk.example.test"],
		["https://Clerk.Example.test:8443/", "https://clerk.example.test:8443"],
		["http://LOCALHOST:80/", "http://localhost"],
		["http://127.0.0.1:18473/", "http://127.0.0.1:18473"],
		["http://[::1]:43120/", "http://[::1]:43120"],
		["http://[0:0:0:0:0:0:0:1]:80/", "http://[::1]"],
		["https://BÜCHER.example:443/", "https://xn--bcher-kva.example"],
		["https://faß.example/", "https://xn--fa-hia.example"],
		["https://[2001:0DB8:0:0:0:0:0:1]:443/", "https://[2001:db8::1]"],
	])("canonicalizes configured issuer origin %s", async (issuer, expected) => {
		const config = await fetchClerkOAuthClientConfig("https://cloud.example.test", {
			fetch: async () =>
				Response.json({
					issuer,
					client_id: CONFIG.clientId,
					audience: CONFIG.audience,
					authorized_parties: CONFIG.authorizedParties,
					redirect_uri: CONFIG.redirectUri,
				}),
		});

		expect(config.issuer).toBe(expected);
	});

	test.each([
		"clerk.example.test",
		"ftp://clerk.example.test",
		"http://clerk.example.test",
		"http://localhost.example.test",
		"http://127.0.0.2",
		"http://[::2]",
		"https://user@clerk.example.test",
		"https://clerk.example.test/oauth",
		"https://clerk.example.test///",
		"https://clerk.example.test?tenant=secret",
		"https://clerk.example.test#fragment",
		"https://clerk.example.test?",
		"https://clerk.example.test#",
		"https://clerk.example.test.",
		"https://bad_host.example.test",
		"https://-bad.example.test",
		"https://[2001:db8::gg]",
	])("rejects invalid configured issuer origin %s", async (issuer) => {
		await expect(
			fetchClerkOAuthClientConfig("https://cloud.example.test", {
				fetch: async () =>
					Response.json({
						issuer,
						client_id: CONFIG.clientId,
						audience: CONFIG.audience,
						authorized_parties: CONFIG.authorizedParties,
						redirect_uri: CONFIG.redirectUri,
					}),
			}),
		).rejects.toThrow("OAuth issuer");
	});

	test("requires the official authorization-code, refresh-token, and S256 discovery contract", async () => {
		const seen: string[] = [];
		const discovery = await fetchClerkOAuthDiscovery(CONFIG, {
			fetch: async (request) => {
				seen.push(request.url);
				return Response.json({
					issuer: CONFIG.issuer,
					authorization_endpoint: DISCOVERY.authorizationEndpoint,
					token_endpoint: DISCOVERY.tokenEndpoint,
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
				});
			},
		});
		expect(discovery).toEqual(DISCOVERY);
		expect(seen).toEqual(["https://clerk.example.test/.well-known/oauth-authorization-server"]);

		await expect(
			fetchClerkOAuthDiscovery(CONFIG, {
				fetch: async () =>
					Response.json({
						issuer: CONFIG.issuer,
						authorization_endpoint: DISCOVERY.authorizationEndpoint,
						token_endpoint: DISCOVERY.tokenEndpoint,
						grant_types_supported: [
							"authorization_code",
							"urn:ietf:params:oauth:grant-type:device_code",
						],
						code_challenge_methods_supported: ["S256"],
						token_endpoint_auth_methods_supported: ["none"],
					}),
			}),
		).rejects.toThrow("public-client PKCE contract");
	});

	test("creates S256 authorization state without a client secret", () => {
		const transaction = createClerkOAuthAuthorization({
			config: CONFIG,
			discovery: DISCOVERY,
			apiUrl: "https://cloud.example.test",
			hostedApiUrl: HOSTED_API_URL,
			now: () => NOW,
		});
		const url = new URL(transaction.authorizationUrl);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
		expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
		expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).not.toBe(transaction.codeVerifier);
		expect(url.searchParams.has("client_secret")).toBe(false);
		setPendingAuth(transaction);
		expect(statSync(join(stateDir, "pending-auth.json")).mode & 0o777).toBe(0o600);
		expect(statSync(stateDir).mode & 0o777).toBe(0o700);
	});

	test("rejects wrong issuer, audience, client, and authorized party", async () => {
		const cases = [
			{ iss: "https://wrong.example.test" },
			{ iss: `${CONFIG.issuer}/` },
			{ aud: "wrong-audience" },
			{ client_id: "wrong-client" },
			{ azp: "https://wrong-origin.example.test" },
			{ exp: Number.MAX_SAFE_INTEGER },
		];
		for (const claims of cases) {
			await expect(
				exchangeClerkOAuthCode(
					pending(),
					`${CONFIG.redirectUri}?code=short-code&state=state-value`,
					{
						now: () => NOW,
						fetch: async () => tokenResponse(accessToken(claims)),
					},
				),
			).rejects.toThrow("wrong issuer, client, audience, or authorized party");
		}
	});

	test("accepts Clerk access tokens without an optional audience", async () => {
		const token = accessToken({ aud: undefined });
		const auth = await exchangeClerkOAuthCode(
			pending(),
			`${CONFIG.redirectUri}?code=short-code&state=state-value`,
			{
				now: () => NOW,
				fetch: async () => tokenResponse(token),
			},
		);
		expect(auth.subject).toBe("user_same_sub");
	});

	test("binds authorized party only when Cloud config provides an expected origin", async () => {
		const cases = [
			{ authorizedParties: [], azp: undefined, accepted: true },
			{ authorizedParties: [], azp: "https://unbound-origin.example.test", accepted: true },
			{ authorizedParties: [AUTHORIZED_PARTY], azp: undefined, accepted: false },
			{ authorizedParties: [AUTHORIZED_PARTY], azp: AUTHORIZED_PARTY, accepted: true },
			{
				authorizedParties: [AUTHORIZED_PARTY],
				azp: "https://wrong-origin.example.test",
				accepted: false,
			},
		] as const;

		for (const testCase of cases) {
			const transaction = { ...pending(), authorizedParties: [...testCase.authorizedParties] };
			const exchange = exchangeClerkOAuthCode(
				transaction,
				`${CONFIG.redirectUri}?code=short-code&state=state-value`,
				{
					now: () => NOW,
					fetch: async () => tokenResponse(accessToken({ azp: testCase.azp })),
				},
			);
			if (testCase.accepted) {
				expect((await exchange).subject).toBe("user_same_sub");
			} else {
				await expect(exchange).rejects.toThrow(
					"wrong issuer, client, audience, or authorized party",
				);
			}
		}
	});

	test("binds audience only when both Cloud config and token provide it", async () => {
		const cases = [
			{ audience: "", aud: { unexpected: "shape" }, accepted: true },
			{ audience: CONFIG.audience, aud: undefined, accepted: true },
			{ audience: CONFIG.audience, aud: CONFIG.audience, accepted: true },
			{ audience: CONFIG.audience, aud: "wrong-audience", accepted: false },
		] as const;

		for (const testCase of cases) {
			const transaction = { ...pending(), audience: testCase.audience };
			const exchange = exchangeClerkOAuthCode(
				transaction,
				`${CONFIG.redirectUri}?code=short-code&state=state-value`,
				{
					now: () => NOW,
					fetch: async () => tokenResponse(accessToken({ aud: testCase.aud })),
				},
			);
			if (testCase.accepted) expect((await exchange).subject).toBe("user_same_sub");
			else {
				await expect(exchange).rejects.toThrow(
					"wrong issuer, client, audience, or authorized party",
				);
			}
		}
	});

	test("persists the refresh grant only after Cloud accepts and enriches it", async () => {
		const auth = await exchangeClerkOAuthCode(
			pending(),
			`${CONFIG.redirectUri}?code=short-code&state=state-value`,
			{ now: () => NOW, fetch: async () => tokenResponse(accessToken(), "refresh-secret") },
		);
		expect(getAuth()).toBeNull();
		const verification = await verifyAndPersistClerkOAuthLogin("https://cloud.example.test", auth, {
			fetch: async () =>
				Response.json({ id: "cloud-local-user", email: "user@example.test", name: "User" }),
		});
		expect(verification).toEqual({
			kind: "verified",
			user: { id: "cloud-local-user", email: "user@example.test", name: "User" },
		});
		expect(getAuth()).toMatchObject({
			authType: "clerk_oauth",
			refreshToken: "refresh-secret",
			scopes: ["openid", "profile", "email", "offline_access"],
			subject: "user_same_sub",
			userId: "cloud-local-user",
			email: "user@example.test",
		});
		expect(statSync(join(stateDir, "auth.json")).mode & 0o777).toBe(0o600);
		expect(statSync(stateDir).mode & 0o777).toBe(0o700);
	});

	test("retains an explicitly unverified grant for Cloud 5xx and network failures", async () => {
		for (const testCase of ["server_error", "network"] as const) {
			const auth = await exchangeClerkOAuthCode(
				pending(),
				`${CONFIG.redirectUri}?code=short-code&state=state-value`,
				{
					now: () => NOW,
					fetch: async () => tokenResponse(accessToken(), `refresh-${testCase}`),
				},
			);
			const verification = await verifyAndPersistClerkOAuthLogin(
				"https://cloud.example.test",
				auth,
				{
					fetch: async () => {
						if (testCase === "network") throw new Error("network body refresh-secret-hidden");
						return new Response("internal body refresh-secret-hidden", { status: 503 });
					},
				},
			);
			expect(verification).toEqual(
				testCase === "network"
					? { kind: "cloud_unverified", reason: "network" }
					: { kind: "cloud_unverified", reason: "server_error", httpStatus: 503 },
			);
			expect(JSON.stringify(verification)).not.toContain(`refresh-${testCase}`);
			expect(getAuth()).toMatchObject({
				authType: "clerk_oauth",
				refreshToken: `refresh-${testCase}`,
				subject: "user_same_sub",
			});
			clearAuth();
		}
	});

	test("revokes best-effort and clears deterministic Cloud rejection without leaking secrets", async () => {
		for (const status of [400, 401, 403] as const) {
			const refreshToken = `refresh-rejected-${status}`;
			const auth = await exchangeClerkOAuthCode(
				pending(),
				`${CONFIG.redirectUri}?code=short-code&state=state-value`,
				{
					now: () => NOW,
					fetch: async () => tokenResponse(accessToken(), refreshToken),
				},
			);
			const requests: Request[] = [];
			let caught: unknown;
			try {
				await verifyAndPersistClerkOAuthLogin("https://cloud.example.test", auth, {
					fetch: async (request) => {
						requests.push(request.clone());
						return request.url.endsWith("/v1/auth/me")
							? new Response(`rejected body ${refreshToken}`, { status })
							: Response.json({ status: "revoked" });
					},
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			const safeError = caught instanceof Error ? caught.message : String(caught);
			expect(safeError).toContain(`HTTP ${status}`);
			expect(safeError).not.toContain(refreshToken);
			expect(getAuth()).toBeNull();
			expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
				"/v1/auth/me",
				"/v1/cli/auth/oauth/revoke",
			]);
			expect(await requests[1]?.text()).toContain(refreshToken);
		}
	});

	test("single-flights refresh and persists a rotated refresh token", async () => {
		setAuth({
			authType: "clerk_oauth",
			apiKey: accessToken({ exp: Math.floor(NOW / 1_000) - 1 }),
			refreshToken: "refresh-old",
			accessTokenExpiresAt: new Date(NOW - 1_000).toISOString(),
			issuer: CONFIG.issuer,
			clientId: CONFIG.clientId,
			audience: CONFIG.audience,
			tokenEndpoint: DISCOVERY.tokenEndpoint,
			scopes: ["openid", "profile", "email"],
			subject: "user_same_sub",
			userId: "cloud-local-user",
			endpointBinding: {
				version: 1,
				cloudApiOrigin: CLOUD_API_URL,
				hostedApiOrigin: HOSTED_API_URL,
			},
		});
		let refreshes = 0;
		const fetcher = async (request: Request) => {
			refreshes += 1;
			expect(await request.text()).toContain("refresh_token=refresh-old");
			return tokenResponse(accessToken(), "refresh-rotated");
		};
		const [first, second] = await Promise.all([
			getClawdiAccessToken(CLOUD_API_URL, { now: () => NOW, fetch: fetcher }),
			getClawdiAccessToken(CLOUD_API_URL, { now: () => NOW, fetch: fetcher }),
		]);
		expect(first).toBe(second);
		expect(refreshes).toBe(1);
		expect(getAuth()).toMatchObject({
			refreshToken: "refresh-rotated",
			userId: "cloud-local-user",
			subject: "user_same_sub",
		});
	});

	test("serializes refresh across two independent CLI processes", async () => {
		let refreshes = 0;
		const server = createServer(async (request, response) => {
			refreshes += 1;
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			expect(Buffer.concat(chunks).toString("utf8")).toContain("refresh_token=refresh-old");
			await new Promise((resolve) => setTimeout(resolve, 50));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing OAuth server port");
			const issuer = `http://127.0.0.1:${address.port}`;
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					access_token: accessToken({
						iss: issuer,
						exp: Math.floor(Date.now() / 1_000) + 3_600,
					}),
					refresh_token: "refresh-rotated",
					token_type: "Bearer",
					scope: "openid profile email",
				}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing OAuth server port");
			const issuer = `http://127.0.0.1:${address.port}`;
			setAuth(
				storedOAuth({
					issuer,
					tokenEndpoint: `${issuer}/oauth/token`,
					apiKey: accessToken({ iss: issuer, exp: Math.floor(Date.now() / 1_000) - 60 }),
					accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
				}),
			);
			const workerEnv: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined && key !== "CLAWDI_AUTH_TOKEN") workerEnv[key] = value;
			}
			workerEnv.CLAWDI_HOME = stateDir;
			const workerPath = join(import.meta.dir, "fixtures", "oauth-refresh-worker.ts");
			const workers = [0, 1].map(() =>
				Bun.spawn([process.execPath, workerPath], {
					env: workerEnv,
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			const results = await Promise.all(
				workers.map(async (worker) => {
					const [exitCode, stdout, stderr] = await Promise.all([
						worker.exited,
						new Response(worker.stdout).text(),
						new Response(worker.stderr).text(),
					]);
					return { exitCode, stdout, stderr };
				}),
			);
			expect(results).toEqual([
				{ exitCode: 0, stdout: "ok\n", stderr: "" },
				{ exitCode: 0, stdout: "ok\n", stderr: "" },
			]);
			expect(refreshes).toBe(1);
			expect(getStoredAuth()).toMatchObject({ refreshToken: "refresh-rotated" });
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	test("clears a refresh credential when Clerk changes the subject", async () => {
		const expiredToken = accessToken({ exp: Math.floor(NOW / 1_000) - 1 });
		setAuth({
			authType: "clerk_oauth",
			apiKey: expiredToken,
			refreshToken: "refresh-old",
			accessTokenExpiresAt: new Date(NOW - 1_000).toISOString(),
			issuer: CONFIG.issuer,
			clientId: CONFIG.clientId,
			audience: CONFIG.audience,
			tokenEndpoint: DISCOVERY.tokenEndpoint,
			scopes: ["openid", "profile", "email"],
			subject: "user_same_sub",
			userId: "cloud-local-user",
			endpointBinding: {
				version: 1,
				cloudApiOrigin: CLOUD_API_URL,
				hostedApiOrigin: HOSTED_API_URL,
			},
		});

		await expect(
			getClawdiAccessToken(CLOUD_API_URL, {
				now: () => NOW,
				fetch: async () => tokenResponse(accessToken({ sub: "user_other" })),
			}),
		).rejects.toThrow("different user");
		expect(getStoredAuth()).toBeNull();
	});

	test("preserves refresh credentials for retryable transport and HTTP failures", async () => {
		for (const failure of ["network", 408, 425, 429, 500, 503] as const) {
			setAuth(storedOAuth());
			const authPath = join(stateDir, "auth.json");
			const before = readFileSync(authPath, "utf8");
			await expect(
				getClawdiAccessToken(CLOUD_API_URL, {
					now: () => NOW,
					fetch: async () => {
						if (failure === "network") {
							throw new ClerkOAuthError("oauth_network_error", "safe network failure");
						}
						return new Response("sensitive response body", { status: failure });
					},
				}),
			).rejects.toThrow();
			expect(readFileSync(authPath, "utf8")).toBe(before);
		}
	});

	test("clears refresh credentials for deterministic HTTP and token failures", async () => {
		const failures: Array<() => Response> = [
			() =>
				new Response('{"error":"invalid_grant","refresh_token":"must-not-leak"}', { status: 400 }),
			() => new Response("invalid client secret detail", { status: 401 }),
			() => Response.json({ token_type: "Bearer" }),
			() => tokenResponse(accessToken({ iss: "https://wrong-issuer.example.test" })),
		];
		for (const response of failures) {
			setAuth(storedOAuth());
			let failure: unknown;
			try {
				await getClawdiAccessToken(CLOUD_API_URL, {
					now: () => NOW,
					fetch: async () => response(),
				});
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(ClerkOAuthError);
			expect(String(failure)).not.toContain("must-not-leak");
			expect(getStoredAuth()).toBeNull();
		}
	});

	test("does not clear a concurrently replaced refresh family after terminal failure", async () => {
		setAuth(storedOAuth());
		const replacement = storedOAuth({ refreshToken: "refresh-newer" });
		await expect(
			getClawdiAccessToken(CLOUD_API_URL, {
				now: () => NOW,
				fetch: async () => {
					setAuth(replacement);
					return new Response('{"error":"invalid_grant"}', { status: 400 });
				},
			}),
		).rejects.toThrow("login");
		expect(getStoredAuth()).toEqual(replacement);
	});

	test("revokes the current refresh grant through Cloud without printing it", async () => {
		setAuth({
			authType: "clerk_oauth",
			apiKey: accessToken(),
			refreshToken: "refresh-to-revoke",
			accessTokenExpiresAt: new Date(NOW + 60 * 60_000).toISOString(),
			issuer: CONFIG.issuer,
			clientId: CONFIG.clientId,
			audience: CONFIG.audience,
			tokenEndpoint: DISCOVERY.tokenEndpoint,
			scopes: ["openid", "profile", "email"],
			subject: "user_same_sub",
			userId: "cloud-local-user",
			endpointBinding: {
				version: 1,
				cloudApiOrigin: CLOUD_API_URL,
				hostedApiOrigin: HOSTED_API_URL,
			},
		});
		let body = "";
		await revokeClerkOAuthSession("https://cloud.example.test", {
			now: () => NOW,
			fetch: async (request) => {
				body = await request.text();
				expect(request.headers.get("authorization")).toBe(`Bearer ${accessToken()}`);
				return Response.json({ status: "revoked" });
			},
		});
		expect(JSON.parse(body)).toEqual({ refresh_token: "refresh-to-revoke" });
	});

	test("refresh-first logout revokes the rotated grant and never resurrects auth", async () => {
		setAuth(storedOAuth());
		let releaseRefresh: (() => void) | undefined;
		let markRefreshStarted: (() => void) | undefined;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const refreshStarted = new Promise<void>((resolve) => {
			markRefreshStarted = resolve;
		});
		const refresh = getClawdiAccessToken(CLOUD_API_URL, {
			now: () => NOW,
			fetch: async () => {
				markRefreshStarted?.();
				await refreshGate;
				return tokenResponse(accessToken(), "refresh-rotated");
			},
		});
		await refreshStarted;
		let revokedBody = "";
		const logout = logoutClawdiCredentials("https://cloud.example.test", {
			now: () => NOW,
			fetch: async (request) => {
				revokedBody = await request.text();
				expect(request.headers.get("authorization")).toBe(`Bearer ${accessToken()}`);
				return Response.json({ status: "revoked" });
			},
		});
		releaseRefresh?.();
		expect(await refresh).toBe(accessToken());
		expect(await logout).toEqual({
			loggedOut: true,
			remoteRevoked: true,
			environmentCredential: false,
		});
		expect(JSON.parse(revokedBody)).toEqual({ refresh_token: "refresh-rotated" });
		expect(getStoredAuth()).toBeNull();
	});

	test("a newer manual login commit wins over an older in-flight refresh", async () => {
		setAuth(storedOAuth());
		const expected = captureStoredCredentialIdentity();
		let releaseRefresh: (() => void) | undefined;
		let markRefreshStarted: (() => void) | undefined;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const refreshStarted = new Promise<void>((resolve) => {
			markRefreshStarted = resolve;
		});
		const oldRefresh = getClawdiAccessToken(CLOUD_API_URL, {
			now: () => NOW,
			fetch: async () => {
				markRefreshStarted?.();
				await refreshGate;
				return tokenResponse(accessToken(), "refresh-from-old-operation");
			},
		});
		await refreshStarted;
		const newerCommit = commitClawdiCredential({ apiKey: "new-manual-login-key" }, expected);
		releaseRefresh?.();
		expect(await oldRefresh).toBe(accessToken());
		await newerCommit;
		expect(getStoredAuth()).toEqual({ apiKey: "new-manual-login-key" });
	});

	test("logout-first refresh rotates then revokes while the waiter fails without resurrection", async () => {
		setAuth(storedOAuth());
		let releaseLogoutRefresh: (() => void) | undefined;
		let markLogoutRefreshStarted: (() => void) | undefined;
		const logoutRefreshGate = new Promise<void>((resolve) => {
			releaseLogoutRefresh = resolve;
		});
		const logoutRefreshStarted = new Promise<void>((resolve) => {
			markLogoutRefreshStarted = resolve;
		});
		const requests: Request[] = [];
		const logout = logoutClawdiCredentials("https://cloud.example.test", {
			now: () => NOW,
			fetch: async (request) => {
				requests.push(request.clone());
				if (request.url === DISCOVERY.tokenEndpoint) {
					markLogoutRefreshStarted?.();
					await logoutRefreshGate;
					return tokenResponse(accessToken(), "refresh-rotated-by-logout");
				}
				return Response.json({ status: "revoked" });
			},
		});
		await logoutRefreshStarted;
		let waiterFetches = 0;
		const waitingRefresh = getClawdiAccessToken(CLOUD_API_URL, {
			now: () => NOW,
			fetch: async () => {
				waiterFetches += 1;
				return tokenResponse(accessToken(), "must-not-win");
			},
		});
		releaseLogoutRefresh?.();
		expect(await logout).toMatchObject({ loggedOut: true, remoteRevoked: true });
		await expect(waitingRefresh).rejects.toThrow("Not logged in");
		expect(waiterFetches).toBe(0);
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/oauth/token",
			"/v1/cli/auth/oauth/revoke",
		]);
		expect(await requests[0]?.text()).toContain("refresh_token=refresh-old");
		expect(JSON.parse((await requests[1]?.text()) ?? "{}")).toEqual({
			refresh_token: "refresh-rotated-by-logout",
		});
		expect(getStoredAuth()).toBeNull();
	});

	test("does not mutate persisted credentials while CLAWDI_AUTH_TOKEN is active", async () => {
		setAuth({ apiKey: "stored-legacy-key" });
		process.env.CLAWDI_AUTH_TOKEN = "environment-only-key";
		const result = await logoutClawdiCredentials("https://cloud.example.test", {
			fetch: async () => {
				throw new Error("environment logout must not call the network");
			},
		});
		expect(result).toEqual({
			loggedOut: false,
			remoteRevoked: false,
			environmentCredential: true,
		});
		expect(getStoredAuth()).toEqual({ apiKey: "stored-legacy-key" });
	});

	test("refuses 307/308 exchange, refresh, and revoke redirects before secrets reach a second origin", async () => {
		let evilRequests = 0;
		const evil = createServer((_request, response) => {
			evilRequests += 1;
			response.end("unexpected");
		});
		await new Promise<void>((resolve) => evil.listen(0, "127.0.0.1", resolve));
		let redirectStatus = 307;
		const firstHopBodies: string[] = [];
		const redirect = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			firstHopBodies.push(Buffer.concat(chunks).toString("utf8"));
			const evilAddress = evil.address();
			if (!evilAddress || typeof evilAddress === "string") {
				throw new Error("missing evil server port");
			}
			response.writeHead(redirectStatus, {
				location: `http://127.0.0.1:${evilAddress.port}/collect`,
			});
			response.end();
		});
		await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
		try {
			const redirectAddress = redirect.address();
			if (!redirectAddress || typeof redirectAddress === "string") {
				throw new Error("missing redirect server port");
			}
			const origin = `http://127.0.0.1:${redirectAddress.port}`;
			for (const status of [307, 308]) {
				redirectStatus = status;
				let exchangeError: unknown;
				try {
					await exchangeClerkOAuthCode(
						{
							...pending(),
							issuer: origin,
							tokenEndpoint: `${origin}/oauth/token`,
							codeVerifier: `verifier-${status}-secret`,
						},
						`${CONFIG.redirectUri}?code=code-${status}-secret&state=state-value`,
						{ now: () => NOW },
					);
				} catch (error) {
					exchangeError = error;
				}
				expect(exchangeError).toBeInstanceOf(Error);
				const exchangeMessage =
					exchangeError instanceof Error ? exchangeError.message : String(exchangeError);
				expect(exchangeMessage).not.toContain(`code-${status}-secret`);
				expect(exchangeMessage).not.toContain(`verifier-${status}-secret`);

				setAuth(
					storedOAuth({
						apiKey: accessToken({ iss: origin, exp: Math.floor(NOW / 1_000) - 1 }),
						issuer: origin,
						tokenEndpoint: `${origin}/oauth/token`,
						refreshToken: `refresh-${status}-secret`,
						endpointBinding: {
							version: 1,
							cloudApiOrigin: origin,
							hostedApiOrigin: HOSTED_API_URL,
						},
					}),
				);
				let refreshError: unknown;
				try {
					await getClawdiAccessToken(origin, { now: () => NOW });
				} catch (error) {
					refreshError = error;
				}
				expect(refreshError).toBeInstanceOf(Error);
				const refreshMessage =
					refreshError instanceof Error ? refreshError.message : String(refreshError);
				expect(refreshMessage).not.toContain(`refresh-${status}-secret`);

				let revokeError: unknown;
				try {
					await revokeClerkOAuthSession(origin);
				} catch (error) {
					revokeError = error;
				}
				expect(revokeError).toBeInstanceOf(Error);
				const revokeMessage =
					revokeError instanceof Error ? revokeError.message : String(revokeError);
				expect(revokeMessage).not.toContain(`refresh-${status}-secret`);
				clearAuth();
			}
			expect(evilRequests).toBe(0);
			expect(firstHopBodies).toHaveLength(6);
			expect(firstHopBodies[0]).toContain("code=code-307-secret");
			expect(firstHopBodies[0]).toContain("code_verifier=verifier-307-secret");
			expect(firstHopBodies[1]).toContain("refresh-307-secret");
			expect(firstHopBodies[2]).toContain("refresh-307-secret");
			expect(firstHopBodies[3]).toContain("code=code-308-secret");
			expect(firstHopBodies[4]).toContain("refresh-308-secret");
			expect(firstHopBodies[5]).toContain("refresh-308-secret");
		} finally {
			await Promise.all([
				new Promise<void>((resolve) => redirect.close(() => resolve())),
				new Promise<void>((resolve) => evil.close(() => resolve())),
			]);
		}
	});
});

describe("Clerk OAuth loopback", () => {
	test("captures only the registered callback path and keeps the code out of HTML", async () => {
		const probe = createServer();
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const address = probe.address();
		if (!address || typeof address === "string") throw new Error("missing probe port");
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
		const loopback = await startClerkOAuthLoopback(redirectUri, "state-value");
		const rejected = await fetch(`${redirectUri}?code=wrong-code&state=wrong-state`);
		expect(rejected.status).toBe(400);
		expect(rejected.headers.get("content-security-policy")).toBe(
			"default-src 'none'; style-src 'unsafe-inline'",
		);
		const rejectedHtml = await rejected.text();
		expect(rejectedHtml).not.toContain("wrong-code");
		expect(rejectedHtml).toContain("Login not completed");
		expect(rejectedHtml).toContain('<div class="brand">Clawdi</div>');
		expect(rejectedHtml).not.toContain("C_");
		const response = await fetch(`${redirectUri}?code=secret-code&state=state-value`);
		expect(response.status).toBe(200);
		const acceptedHtml = await response.text();
		expect(acceptedHtml).not.toContain("secret-code");
		expect(acceptedHtml).toContain("Login complete");
		expect(acceptedHtml).toContain('<div class="brand">Clawdi</div>');
		expect(acceptedHtml).not.toContain("C_");
		expect(acceptedHtml).not.toContain("<script");
		expect(await loopback.callbackUrl).toBe(`${redirectUri}?code=secret-code&state=state-value`);
		await loopback.close();
	});
});
