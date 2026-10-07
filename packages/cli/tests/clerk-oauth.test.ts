import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClerkDevicePollOptions,
	type ClerkOAuthClientConfig,
	type ClerkOAuthDiscovery,
	ClerkOAuthError,
	captureStoredCredentialIdentity,
	commitClawdiCredential,
	fetchClerkOAuthClientConfig,
	fetchClerkOAuthDiscovery,
	getClawdiAccessToken,
	logoutClawdiCredentials,
	pollClerkDeviceToken,
	pollClerkDeviceTokenOnce,
	revokeClerkOAuthSession,
	startClerkDeviceAuthorization,
	verifyAndPersistClerkOAuthLogin,
} from "../src/lib/clerk-oauth";
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
const CLOUD_API_URL = "https://cloud.example.test";
const HOSTED_API_URL = "https://deploy.example.test";
const CONFIG: ClerkOAuthClientConfig = {
	issuer: "https://clerk.example.test",
	clientId: "clawdi-cli",
};
const DISCOVERY: ClerkOAuthDiscovery = {
	issuer: CONFIG.issuer,
	deviceAuthorizationEndpoint: `${CONFIG.issuer}/oauth/device_authorization`,
	tokenEndpoint: `${CONFIG.issuer}/oauth/token`,
};

function accessToken(_overrides: Record<string, unknown> = {}): string {
	return "opaque-access-token";
}

function storedOAuth(overrides: Partial<ClerkOAuthAuth> = {}): ClerkOAuthAuth {
	return {
		authType: "clerk_oauth",
		apiKey: accessToken({ exp: Math.floor(NOW / 1_000) - 1 }),
		refreshToken: "refresh-old",
		accessTokenExpiresAt: new Date(NOW - 1_000).toISOString(),
		issuer: CONFIG.issuer,
		clientId: CONFIG.clientId,
		tokenEndpoint: DISCOVERY.tokenEndpoint,
		scopes: ["openid", "profile", "email"],
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
		authType: "clerk_oauth_device",
		state: "state-value",
		deviceCode: "private-device-code",
		userCode: "ABCD-EFGH",
		verificationUri: "https://accounts.example.test/device",
		verificationUriComplete: "https://accounts.example.test/device?user_code=ABCD-EFGH",
		interval: 5,
		issuer: CONFIG.issuer,
		clientId: CONFIG.clientId,
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

function discoveryBody(overrides: Record<string, unknown> = {}) {
	return {
		issuer: CONFIG.issuer,
		device_authorization_endpoint: DISCOVERY.deviceAuthorizationEndpoint,
		token_endpoint: DISCOVERY.tokenEndpoint,
		grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none"],
		...overrides,
	};
}

function deviceBody(overrides: Record<string, unknown> = {}) {
	return {
		device_code: "private-device-code",
		user_code: "ABCD-EFGH",
		verification_uri: "https://accounts.example.test/device",
		verification_uri_complete: "https://accounts.example.test/device?user_code=ABCD-EFGH",
		expires_in: 600,
		interval: 5,
		...overrides,
	};
}

function startDevice(
	overrides: Record<string, unknown> = {},
	fetcher?: (request: Request) => Promise<Response>,
) {
	return startClerkDeviceAuthorization({
		config: CONFIG,
		discovery: DISCOVERY,
		apiUrl: CLOUD_API_URL,
		hostedApiUrl: HOSTED_API_URL,
		now: () => NOW,
		fetch: fetcher ?? (async () => Response.json(deviceBody(overrides))),
	});
}

function pollDevice(transaction: PendingAuth, options: ClerkDevicePollOptions = {}) {
	return pollClerkDeviceToken(transaction, { sleep: async () => {}, ...options });
}

function tokenResponse(token: string, refreshToken = "refresh-new"): Response {
	return Response.json({
		access_token: token,
		refresh_token: refreshToken,
		token_type: "Bearer",
		expires_in: 3600,
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
	// The state home is private CLI-owned state; the CLI creates it at 0700
	// (mkdir modes are umask-filtered, so re-assert the exact mode).
	mkdirSync(stateDir, { recursive: true });
	chmodSync(stateDir, 0o700);
	process.env.CLAWDI_HOME = stateDir;
});

afterEach(() => {
	if (priorClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = priorClawdiHome;
	if (priorAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
	else process.env.CLAWDI_AUTH_TOKEN = priorAuthToken;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("Clerk public OAuth device authorization", () => {
	test("ignores legacy audience and authorized-party response fields", async () => {
		const config = await fetchClerkOAuthClientConfig("https://cloud.example.test", {
			fetch: async () =>
				Response.json({
					issuer: CONFIG.issuer,
					client_id: CONFIG.clientId,
					audience: "legacy-audience",
					authorized_parties: ["https://legacy.example.test"],
					redirect_uri: "http://127.0.0.1:18473/oauth/callback",
				}),
		});
		expect(config).toEqual({ ...CONFIG, redirectUri: "http://127.0.0.1:18473/oauth/callback" });
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
					redirect_uri: "ignored-by-device-flow",
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
						redirect_uri: "ignored-by-device-flow",
					}),
			}),
		).rejects.toThrow("OAuth issuer");
	});

	test("requires device and refresh grants without PKCE metadata", async () => {
		const seen: string[] = [];
		const discovery = await fetchClerkOAuthDiscovery(CONFIG, {
			fetch: async (request) => {
				seen.push(request.url);
				return Response.json(discoveryBody());
			},
		});
		expect(discovery).toEqual(DISCOVERY);
		expect(seen).toEqual([`${CONFIG.issuer}/.well-known/oauth-authorization-server`]);
	});

	test.each([
		{ device_authorization_endpoint: undefined },
		{ grant_types_supported: ["authorization_code", "refresh_token"] },
		{ grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"] },
	])("reports unavailable device grant for %j", async (overrides) => {
		await expect(
			fetchClerkOAuthDiscovery(CONFIG, {
				fetch: async () => Response.json(discoveryBody(overrides)),
			}),
		).rejects.toMatchObject({
			code: "oauth_device_grant_unavailable",
			message: expect.stringContaining("API keys can no longer be created"),
		});
	});

	test.each(["device_authorization_endpoint", "token_endpoint"])(
		"rejects cross-origin %s",
		async (field) => {
			await expect(
				fetchClerkOAuthDiscovery(CONFIG, {
					fetch: async () =>
						Response.json(discoveryBody({ [field]: "https://other.example.test/token" })),
				}),
			).rejects.toMatchObject({ code: "invalid_oauth_discovery" });
		},
	);

	test("requires public-client token authentication", async () => {
		await expect(
			fetchClerkOAuthDiscovery(CONFIG, {
				fetch: async () =>
					Response.json(
						discoveryBody({ token_endpoint_auth_methods_supported: ["client_secret_basic"] }),
					),
			}),
		).rejects.toMatchObject({ code: "invalid_oauth_discovery" });
	});

	test("starts device authorization using server lifetime and interval, then stores it privately", async () => {
		const requests: Request[] = [];
		const transaction = await startDevice({}, async (request) => {
			requests.push(request.clone());
			return Response.json(deviceBody({ expires_in: 123, interval: 7 }));
		});
		expect(requests[0]?.url).toBe(DISCOVERY.deviceAuthorizationEndpoint);
		expect(requests[0]?.redirect).toBe("error");
		const form = new URLSearchParams(await requests[0]?.text());
		expect(Object.fromEntries(form)).toEqual({
			client_id: CONFIG.clientId,
			scope: "openid profile email offline_access",
		});
		expect(transaction).toMatchObject({
			authType: "clerk_oauth_device",
			interval: 7,
			expiresAt: new Date(NOW + 123_000).toISOString(),
		});
		setPendingAuth(transaction);
		expect(statSync(join(stateDir, "pending-auth.json")).mode & 0o777).toBe(0o600);
		expect(statSync(stateDir).mode & 0o777).toBe(0o700);
	});

	test("defaults only a missing interval and accepts a missing complete URI", async () => {
		expect(
			await startDevice({ interval: undefined, verification_uri_complete: undefined }),
		).toMatchObject({ interval: 5, verificationUri: "https://accounts.example.test/device" });
	});

	test.each([
		{ expires_in: 0 },
		{ expires_in: 3601 },
		{ expires_in: 1.5 },
		{ expires_in: "600" },
		{ interval: 0 },
		{ interval: 61 },
		{ interval: 1.5 },
		{ interval: "5" },
		{ interval: null },
		{ device_code: "" },
		{ user_code: "" },
		{ verification_uri: "http://accounts.example.test/device" },
		{ verification_uri_complete: "http://accounts.example.test/device" },
		{ verification_uri: "https://user:password@accounts.example.test/device" },
	])("rejects invalid device response %j without exposing device code", async (overrides) => {
		try {
			await startDevice(overrides);
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(ClerkOAuthError);
			expect(String(error)).not.toContain("private-device-code");
		}
	});

	test.each(["unauthorized_client", "unsupported_grant_type"])(
		"reports %s from device start safely",
		async (error) => {
			await expect(
				startDevice({}, async () =>
					Response.json({ error, error_description: "private-device-code" }, { status: 400 }),
				),
			).rejects.toMatchObject({ code: "oauth_device_grant_unavailable" });
		},
	);

	test("waits the interval between pending responses and approval", async () => {
		let time = NOW;
		const sleeps: number[] = [];
		const requests: Request[] = [];
		const replies = ["authorization_pending", "authorization_pending", "success"];
		await pollClerkDeviceToken(pending(), {
			now: () => time,
			sleep: async (ms) => {
				sleeps.push(ms);
				time += ms;
			},
			fetch: async (request) => {
				requests.push(request.clone());
				const error = replies.shift();
				return error === "success"
					? tokenResponse(accessToken())
					: Response.json({ error }, { status: 400 });
			},
		});
		expect(sleeps).toEqual([5_000, 5_000, 5_000]);
		expect(Object.fromEntries(new URLSearchParams(await requests[0]?.text()))).toEqual({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: "private-device-code",
			client_id: CONFIG.clientId,
		});
	});

	test("slow_down adds five seconds to all subsequent waits", async () => {
		const sleeps: number[] = [];
		const intervals: number[] = [];
		const replies = ["slow_down", "authorization_pending", "success"];
		await pollClerkDeviceToken(pending(), {
			now: () => NOW,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			onSlowDown: (value) => {
				intervals.push(value.interval);
			},
			fetch: async () => {
				const error = replies.shift();
				return error === "success"
					? tokenResponse(accessToken())
					: Response.json({ error }, { status: 400 });
			},
		});
		expect(sleeps).toEqual([5_000, 10_000, 10_000]);
		expect(intervals).toEqual([10]);
	});

	test.each([503, 408, 425, 429, "network"])("retries %s with bounded backoff", async (status) => {
		let calls = 0;
		const sleeps: number[] = [];
		await pollClerkDeviceToken(pending(), {
			now: () => NOW,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			fetch: async () => {
				if (++calls > 2) return tokenResponse(accessToken());
				if (status === "network") throw new Error("private-device-code");
				return new Response("private-device-code", { status });
			},
		});
		expect(sleeps).toEqual([5_000, 10_000, 10_000]);
	});

	test.each([
		["access_denied", "oauth_denied"],
		["expired_token", "oauth_login_expired"],
		["unauthorized_client", "oauth_device_grant_unavailable"],
		["unsupported_grant_type", "oauth_device_grant_unavailable"],
		["invalid_grant", "oauth_exchange_failed"],
		["invalid_client", "oauth_exchange_failed"],
		["unexpected_error", "oauth_exchange_failed"],
	])("stops on %s without leaking private response details", async (error, code) => {
		let caught: unknown;
		try {
			await pollDevice(pending(), {
				now: () => NOW,
				fetch: async () =>
					Response.json({ error, error_description: "private-device-code" }, { status: 400 }),
			});
		} catch (failure) {
			caught = failure;
		}
		expect(caught).toMatchObject({ code });
		expect(String(caught)).not.toContain("private-device-code");
	});

	test("local expiry stops before making a request", async () => {
		let calls = 0;
		let time = NOW;
		await expect(
			pollClerkDeviceToken(
				{ ...pending(), expiresAt: new Date(NOW + 3_000).toISOString() },
				{
					now: () => time,
					sleep: async (ms) => {
						time += ms;
					},
					fetch: async () => {
						calls++;
						return tokenResponse(accessToken());
					},
				},
			),
		).rejects.toMatchObject({ code: "oauth_login_expired" });
		expect(calls).toBe(0);
	});

	test("accepts an opaque access token and uses expires_in metadata", async () => {
		const auth = await pollDevice(pending(), {
			now: () => NOW,
			fetch: async () => tokenResponse("opaque-token"),
		});
		expect(auth.apiKey).toBe("opaque-token");
		expect(auth.userId).toBe("");
		expect(auth.accessTokenExpiresAt).toBe(new Date(NOW + 3_600_000).toISOString());
	});

	test("persists the refresh grant only after Cloud accepts and enriches it", async () => {
		const auth = await pollDevice(pending(), {
			now: () => NOW,
			fetch: async () => tokenResponse(accessToken(), "refresh-secret"),
		});
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
			userId: "cloud-local-user",
			email: "user@example.test",
		});
		expect(statSync(join(stateDir, "auth.json")).mode & 0o777).toBe(0o600);
		expect(statSync(stateDir).mode & 0o777).toBe(0o700);
	});

	test("retains an explicitly unverified grant for Cloud 5xx and network failures", async () => {
		for (const testCase of ["server_error", "network"] as const) {
			const auth = await pollDevice(pending(), {
				now: () => NOW,
				fetch: async () => tokenResponse(accessToken(), `refresh-${testCase}`),
			});
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
			});
			clearAuth();
		}
	});

	test("revokes best-effort and clears deterministic Cloud rejection without leaking secrets", async () => {
		for (const status of [400, 401, 403] as const) {
			const refreshToken = `refresh-rejected-${status}`;
			const auth = await pollDevice(pending(), {
				now: () => NOW,
				fetch: async () => tokenResponse(accessToken(), refreshToken),
			});
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
			tokenEndpoint: DISCOVERY.tokenEndpoint,
			scopes: ["openid", "profile", "email"],
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
					expires_in: 3600,
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
			() => Response.json({ access_token: "opaque-token", token_type: "Bearer" }),
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
			tokenEndpoint: DISCOVERY.tokenEndpoint,
			scopes: ["openid", "profile", "email"],
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
		await expect(waitingRefresh).rejects.toThrow("Not signed in");
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
				const exchangeResult = await pollClerkDeviceTokenOnce(
					{
						...pending(),
						issuer: origin,
						tokenEndpoint: `${origin}/oauth/token`,
						deviceCode: `device-${status}-secret`,
					},
					{ now: () => NOW },
				);
				expect(exchangeResult).toEqual({ status: "pending", retryable: true });

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
			expect(firstHopBodies[0]).toContain("device_code=device-307-secret");
			expect(firstHopBodies[1]).toContain("refresh-307-secret");
			expect(firstHopBodies[2]).toContain("refresh-307-secret");
			expect(firstHopBodies[3]).toContain("device_code=device-308-secret");
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
