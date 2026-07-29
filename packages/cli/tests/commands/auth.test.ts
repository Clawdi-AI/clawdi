import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authLogin, browserOpenCommand, finishOAuthLogin } from "../../src/commands/auth";
import {
	clearAuth,
	getAuth,
	getPendingAuth,
	type PendingAuth,
	setPendingAuth,
} from "../../src/lib/config";
import { addToken } from "../../src/share/tokens";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origApiUrl: string | undefined;
let origAuthToken: string | undefined;
let origExitCode: typeof process.exitCode;

const rawToken = "a".repeat(43);

function oauthAccessToken(): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "at+jwt" })}.${encode({
		iss: "https://clerk.example.test",
		client_id: "clawdi-cli",
		aud: "clawdi-api",
		azp: "https://accounts.clawdi.test",
		sub: "oauth-user",
		exp: Math.floor(Date.now() / 1_000) + 3_600,
	})}.signature`;
}

function oauthPending(): PendingAuth {
	return {
		authType: "clerk_oauth_pkce",
		state: "interactive-state",
		codeVerifier: "interactive-verifier",
		authorizationUrl: "https://clerk.example.test/oauth/authorize",
		redirectUri: "http://127.0.0.1:18473/oauth/callback",
		issuer: "https://clerk.example.test",
		clientId: "clawdi-cli",
		audience: "clawdi-api",
		authorizedParties: ["https://accounts.clawdi.test"],
		tokenEndpoint: "https://clerk.example.test/oauth/token",
		expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
		apiUrl: "https://api.test",
		endpointBinding: {
			version: 1,
			cloudApiOrigin: "https://api.test",
			hostedApiOrigin: "http://localhost:50021",
		},
		scopes: ["openid", "profile", "email", "offline_access"],
	};
}

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	origAuthToken = process.env.CLAWDI_AUTH_TOKEN;
	origExitCode = process.exitCode;

	tmpHome = join(tmpdir(), `clawdi-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(
		join(tmpHome, ".clawdi", "auth.json"),
		JSON.stringify({
			apiKey: "bob-key",
			userId: "bob",
			email: "bob@example.test",
			endpointBinding: { version: 1, cloudApiOrigin: "https://api.test" },
		}),
	);

	process.env.HOME = tmpHome;
	delete process.env.CLAWDI_HOME;
	process.env.CLAWDI_API_URL = "https://api.test";
	delete process.env.CLAWDI_AUTH_TOKEN;
	process.exitCode = undefined;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origClawdiHome) process.env.CLAWDI_HOME = origClawdiHome;
	else delete process.env.CLAWDI_HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	if (origAuthToken) process.env.CLAWDI_AUTH_TOKEN = origAuthToken;
	else delete process.env.CLAWDI_AUTH_TOKEN;
	process.exitCode = origExitCode;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("authLogin authentication boundary", () => {
	it("uses a real executable for browser opening on every supported platform", () => {
		expect(browserOpenCommand("https://example.test", "darwin")).toEqual({
			command: "open",
			args: ["https://example.test"],
		});
		expect(browserOpenCommand("https://example.test", "linux")).toEqual({
			command: "xdg-open",
			args: ["https://example.test"],
		});
		expect(browserOpenCommand("https://example.test?a=1&b=2", "win32")).toEqual({
			command: "rundll32.exe",
			args: ["url.dll,FileProtocolHandler", "https://example.test?a=1&b=2"],
		});
	});

	it("starts Clerk Authorization Code + PKCE without calling a device grant", async () => {
		rmSync(join(tmpHome, ".clawdi", "auth.json"), { force: true });
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/cli/auth/oauth/config",
				response: () =>
					jsonResponse({
						issuer: "https://clerk.example.test",
						client_id: "clawdi-cli",
						audience: "clawdi-api",
						authorized_parties: ["https://accounts.clawdi.test"],
						redirect_uri: "http://127.0.0.1:18473/oauth/callback",
					}),
			},
			{
				method: "GET",
				path: "/.well-known/oauth-authorization-server",
				response: () =>
					jsonResponse({
						issuer: "https://clerk.example.test",
						authorization_endpoint: "https://clerk.example.test/oauth/authorize",
						token_endpoint: "https://clerk.example.test/oauth/token",
						grant_types_supported: ["authorization_code", "refresh_token"],
						code_challenge_methods_supported: ["S256"],
						token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
					}),
			},
		]);

		try {
			await authLogin({ open: false });
			const { getPendingAuth } = await import("../../src/lib/config");
			const pending = getPendingAuth();
			expect(pending?.authType).toBe("clerk_oauth_pkce");
			expect(pending?.endpointBinding).toEqual({
				version: 1,
				cloudApiOrigin: "https://api.test",
				hostedApiOrigin: "http://localhost:50021",
			});
			const authorizationUrl = new URL(pending?.authorizationUrl ?? "");
			expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
			expect(authorizationUrl.searchParams.has("client_secret")).toBe(false);
		} finally {
			restore();
		}

		expect(captured.map((request) => request.path)).toEqual([
			"/v1/cli/auth/oauth/config",
			"/.well-known/oauth-authorization-server",
		]);
	});
});

describe("interactive OAuth Cloud verification boundary", () => {
	it("persists both verified and explicitly cloud-unverified grants without fake profile data", async () => {
		addToken({
			project_id: "project-shared",
			project_name: "Team Toolkit",
			owner_display: "Alice",
			owner_handle: "alice-example",
			token: rawToken,
			redeemed_at: "2026-05-12T10:00:00Z",
		});
		const localShareBefore = readFileSync(join(tmpHome, ".clawdi", "share-tokens.json"), "utf-8");
		for (const cloudCase of ["verified", "server_error", "network"] as const) {
			clearAuth();
			const pending = oauthPending();
			setPendingAuth(pending);
			const { captured, restore } = mockFetch([
				{
					method: "POST",
					path: "/oauth/token",
					response: () =>
						jsonResponse({
							access_token: oauthAccessToken(),
							refresh_token: `refresh-${cloudCase}`,
							token_type: "Bearer",
							scope: "openid profile email offline_access",
						}),
				},
				{
					method: "GET",
					path: "/v1/auth/me",
					response: () => {
						if (cloudCase === "network") throw new TypeError("private network detail");
						return cloudCase === "verified"
							? jsonResponse({
									id: "cloud-user",
									email: "user@example.test",
									name: "User",
								})
							: new Response("temporary internal detail", { status: 503 });
					},
				},
			]);
			try {
				expect(
					await finishOAuthLogin(
						pending,
						`${pending.redirectUri}?code=interactive-code&state=${pending.state}`,
						{ kind: "none" },
					),
				).toBe(true);
			} finally {
				restore();
			}
			expect(getAuth()).toMatchObject(
				cloudCase === "verified"
					? {
							refreshToken: "refresh-verified",
							userId: "cloud-user",
							email: "user@example.test",
						}
					: { refreshToken: `refresh-${cloudCase}`, userId: "oauth-user" },
			);
			expect(getAuth()?.endpointBinding).toEqual(pending.endpointBinding);
			expect(getPendingAuth()).toBeNull();
			expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
				"POST /oauth/token",
				"GET /v1/auth/me",
			]);
			expect(readFileSync(join(tmpHome, ".clawdi", "share-tokens.json"), "utf-8")).toBe(
				localShareBefore,
			);
		}
	});

	it("revokes and clears deterministic or malformed Cloud rejection", async () => {
		for (const cloudCase of ["unauthorized", "forbidden", "malformed"] as const) {
			clearAuth();
			const pending = oauthPending();
			setPendingAuth(pending);
			const { captured, restore } = mockFetch([
				{
					method: "POST",
					path: "/oauth/token",
					response: () =>
						jsonResponse({
							access_token: oauthAccessToken(),
							refresh_token: `refresh-${cloudCase}`,
							token_type: "Bearer",
							scope: "openid profile email offline_access",
						}),
				},
				{
					method: "GET",
					path: "/v1/auth/me",
					response: () =>
						cloudCase === "malformed"
							? jsonResponse({ email: "missing-id@example.test" })
							: new Response("private rejection detail", {
									status: cloudCase === "unauthorized" ? 401 : 403,
								}),
				},
				{
					method: "POST",
					path: "/v1/cli/auth/oauth/revoke",
					response: () => jsonResponse({ status: "revoked" }),
				},
			]);
			try {
				await expect(
					finishOAuthLogin(
						pending,
						`${pending.redirectUri}?code=interactive-code&state=${pending.state}`,
						{ kind: "none" },
					),
				).rejects.toThrow();
			} finally {
				restore();
			}
			expect(getAuth()).toBeNull();
			expect(getPendingAuth()).toBeNull();
			expect(captured.map((request) => new URL(request.url).pathname)).toEqual([
				"/oauth/token",
				"/v1/auth/me",
				"/v1/cli/auth/oauth/revoke",
			]);
		}
	});
});
