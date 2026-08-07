import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, unwrap } from "../src/lib/api-client";
import { setAuth } from "../src/lib/config";
import {
	assertHostedDeployAccessToken,
	createHostedDeployAuthProvider,
	HostedDeployAuthorizationError,
} from "../src/lib/hosted-deploy-auth";
import {
	HostedDeployClient,
	normalizeHostedDeployApiBaseUrl,
} from "../src/lib/hosted-deploy-client";

function oauthToken(exp: number): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "at+jwt" })}.${encode({
		iss: "https://clerk.example.test",
		client_id: "clawdi-cli",
		aud: "clawdi-api",
		sub: "user_same_sub",
		exp,
	})}.signature`;
}

let priorClawdiHome: string | undefined;
let priorApiUrl: string | undefined;
let priorFetch: typeof globalThis.fetch;
let stateDir: string;

beforeEach(() => {
	priorClawdiHome = process.env.CLAWDI_HOME;
	priorApiUrl = process.env.CLAWDI_API_URL;
	priorFetch = globalThis.fetch;
	stateDir = join(tmpdir(), `clawdi-hosted-auth-${crypto.randomUUID()}`);
	mkdirSync(stateDir, { recursive: true });
	process.env.CLAWDI_HOME = stateDir;
	process.env.CLAWDI_API_URL = "https://cloud.example.test";
});

afterEach(() => {
	if (priorClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = priorClawdiHome;
	if (priorApiUrl === undefined) delete process.env.CLAWDI_API_URL;
	else process.env.CLAWDI_API_URL = priorApiUrl;
	globalThis.fetch = priorFetch;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("Hosted deploy auth boundary", () => {
	test("requires TLS except on exact loopback hosts", () => {
		expect(normalizeHostedDeployApiBaseUrl("https://api.clawdi.ai/v2")).toBe(
			"https://api.clawdi.ai",
		);
		expect(normalizeHostedDeployApiBaseUrl("http://localhost:50021/v2")).toBe(
			"http://localhost:50021",
		);
		expect(normalizeHostedDeployApiBaseUrl("http://127.0.0.1:50021")).toBe(
			"http://127.0.0.1:50021",
		);
		expect(normalizeHostedDeployApiBaseUrl("http://[::1]:50021")).toBe("http://[::1]:50021");
		expect(() => normalizeHostedDeployApiBaseUrl("http://api.clawdi.ai")).toThrow("must use HTTPS");
		expect(() => normalizeHostedDeployApiBaseUrl("http://localhost.example.com")).toThrow(
			"must use HTTPS",
		);
	});

	test("requires the single canonical Clerk OAuth login", async () => {
		const provider = createHostedDeployAuthProvider({
			cloudApiUrl: "https://cloud.example.test",
			hostedApiUrl: "https://deploy.example.test",
		});
		await expect(provider.getAccessToken()).rejects.toBeInstanceOf(HostedDeployAuthorizationError);
	});

	test("rejects legacy Cloud keys and expired OAuth credentials", () => {
		const now = Date.parse("2026-07-28T00:00:00Z");
		expect(() =>
			assertHostedDeployAccessToken(
				{ token: "clawdi_cloud_user_key", expiresAt: "2026-07-28T00:05:00Z" },
				now,
			),
		).toThrow("legacy Clawdi API key");
		expect(() =>
			assertHostedDeployAccessToken(
				{ token: oauthToken(Math.floor(now / 1_000)), expiresAt: "2026-07-28T00:00:01Z" },
				now,
			),
		).toThrow("expired");
	});

	test("reuses one refreshed Clerk token for Cloud and Hosted requests", async () => {
		const now = Date.now();
		const expiresAt = now + 60 * 60_000;
		const expiredToken = oauthToken(Math.floor((now - 60_000) / 1_000));
		const token = oauthToken(Math.floor(expiresAt / 1_000));
		setAuth({
			authType: "clerk_oauth",
			apiKey: expiredToken,
			refreshToken: "refresh-secret",
			accessTokenExpiresAt: new Date(now - 60_000).toISOString(),
			issuer: "https://clerk.example.test",
			clientId: "clawdi-cli",
			audience: "clawdi-api",
			tokenEndpoint: "https://clerk.example.test/oauth/token",
			scopes: ["openid", "profile", "email"],
			subject: "user_same_sub",
			userId: "cloud-local-user",
			endpointBinding: {
				version: 1,
				cloudApiOrigin: "https://cloud.example.test",
				hostedApiOrigin: "https://deploy.example.test",
			},
		});

		const authorizations: string[] = [];
		const requestUrls: string[] = [];
		let refreshes = 0;
		globalThis.fetch = async (request) => {
			if (request.url === "https://clerk.example.test/oauth/token") {
				refreshes += 1;
				return Response.json({
					access_token: token,
					refresh_token: "refresh-rotated",
					token_type: "Bearer",
					scope: "openid profile email",
				});
			}
			authorizations.push(request.headers.get("authorization") ?? "");
			return Response.json({
				id: "cloud-local-user",
				email: "user@example.test",
				name: "User",
				auth_type: "clerk",
			});
		};
		const cloud = new ApiClient();
		await unwrap(cloud.GET("/v1/auth/me"));

		const hosted = new HostedDeployClient({
			baseUrl: "https://deploy.example.test",
			fetch: async (request) => {
				authorizations.push(request.headers.get("authorization") ?? "");
				requestUrls.push(request.url);
				return request.url.endsWith("/v1/ai-providers")
					? Response.json({ providers: [] })
					: Response.json([]);
			},
		});
		await hosted.getPlans();
		await hosted.getSavedAiProviders();

		expect(refreshes).toBe(1);
		expect(authorizations).toEqual([`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`]);
		expect(requestUrls).toEqual([
			"https://deploy.example.test/v2/subscription/plans",
			"https://cloud.example.test/v1/ai-providers",
		]);
	});
});
