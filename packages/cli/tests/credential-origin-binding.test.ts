import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStatus } from "../src/commands/auth";
import { ApiClient, unwrap } from "../src/lib/api-client";
import { normalizeCloudApiBaseUrl, normalizeHostedDeployApiBaseUrl } from "../src/lib/api-origin";
import {
	getClawdiAccessToken,
	logoutClawdiCredentials,
	revokeClerkOAuthSession,
} from "../src/lib/clerk-oauth";
import { type ClerkOAuthAuth, getStoredAuth, setAuth, setConfig } from "../src/lib/config";
import { HostedDeployClient } from "../src/lib/hosted-deploy-client";

const CLOUD_ORIGIN = "https://cloud.example.test";
const HOSTED_ORIGIN = "https://hosted.example.test";
const PRODUCTION_CLOUD_ORIGIN = "https://cloud-api.clawdi.ai";

function oauthAuth(
	endpointBinding: ClerkOAuthAuth["endpointBinding"] | null = {
		version: 1,
		cloudApiOrigin: CLOUD_ORIGIN,
		hostedApiOrigin: HOSTED_ORIGIN,
	},
): ClerkOAuthAuth {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const accessToken = `${encode({ alg: "RS256", typ: "at+jwt" })}.${encode({
		exp: Math.floor(Date.now() / 1_000) + 3_600,
		sub: "oauth-user",
	})}.signature`;
	return {
		authType: "clerk_oauth",
		apiKey: accessToken,
		refreshToken: "oauth-refresh-secret",
		accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
		issuer: "https://clerk.example.test",
		clientId: "clawdi-cli",
		audience: "clawdi-api",
		tokenEndpoint: "https://clerk.example.test/oauth/token",
		scopes: ["openid", "profile", "email"],
		subject: "oauth-user",
		userId: "cloud-user",
		...(endpointBinding ? { endpointBinding } : {}),
	};
}

let priorClawdiHome: string | undefined;
let priorApiUrl: string | undefined;
let priorDeployApiUrl: string | undefined;
let priorAuthToken: string | undefined;
let priorAuthTokenOrigin: string | undefined;
let priorFetch: typeof globalThis.fetch;
let stateDir: string;

beforeEach(() => {
	priorClawdiHome = process.env.CLAWDI_HOME;
	priorApiUrl = process.env.CLAWDI_API_URL;
	priorDeployApiUrl = process.env.CLAWDI_DEPLOY_API_URL;
	priorAuthToken = process.env.CLAWDI_AUTH_TOKEN;
	priorAuthTokenOrigin = process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
	priorFetch = globalThis.fetch;
	stateDir = join(tmpdir(), `clawdi-origin-binding-${crypto.randomUUID()}`);
	mkdirSync(stateDir, { recursive: true });
	process.env.CLAWDI_HOME = stateDir;
	delete process.env.CLAWDI_API_URL;
	delete process.env.CLAWDI_DEPLOY_API_URL;
	delete process.env.CLAWDI_AUTH_TOKEN;
	delete process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
});

afterEach(() => {
	if (priorClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = priorClawdiHome;
	if (priorApiUrl === undefined) delete process.env.CLAWDI_API_URL;
	else process.env.CLAWDI_API_URL = priorApiUrl;
	if (priorDeployApiUrl === undefined) delete process.env.CLAWDI_DEPLOY_API_URL;
	else process.env.CLAWDI_DEPLOY_API_URL = priorDeployApiUrl;
	if (priorAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
	else process.env.CLAWDI_AUTH_TOKEN = priorAuthToken;
	if (priorAuthTokenOrigin === undefined) delete process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
	else process.env.CLAWDI_AUTH_TOKEN_ORIGIN = priorAuthTokenOrigin;
	globalThis.fetch = priorFetch;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("credential endpoint normalization", () => {
	test("canonicalizes scheme, hostname, effective port, and trailing slash", () => {
		expect(normalizeCloudApiBaseUrl("https://CLOUD.Example.Test:443/")).toBe(CLOUD_ORIGIN);
		expect(normalizeCloudApiBaseUrl("http://LOCALHOST:80/")).toBe("http://localhost");
		expect(normalizeHostedDeployApiBaseUrl("https://HOSTED.Example.Test:443/v2")).toBe(
			HOSTED_ORIGIN,
		);
		expect(normalizeHostedDeployApiBaseUrl("https://hosted.example.test/v2/")).toBe(HOSTED_ORIGIN);
	});

	test("rejects unsafe components and non-compatible paths", () => {
		const cloudInvalid = [
			"cloud.example.test",
			"ftp://cloud.example.test",
			"http://cloud.example.test",
			"https://user:secret@cloud.example.test",
			"https://@cloud.example.test",
			"https://cloud.example.test/v1",
			"https://cloud.example.test?tenant=evil",
			"https://cloud.example.test#evil",
			"https://cloud.example.test.",
			"https://bad_host.example.test",
		];
		for (const invalid of cloudInvalid) {
			expect(() => normalizeCloudApiBaseUrl(invalid)).toThrow();
		}
		for (const invalid of [
			"http://hosted.example.test",
			"https://hosted.example.test/v1",
			"https://hosted.example.test/v2/agents",
			"https://hosted.example.test/v2?tenant=evil",
			"https://user@hosted.example.test/v2",
		]) {
			expect(() => normalizeHostedDeployApiBaseUrl(invalid)).toThrow();
		}
	});
});

describe("Cloud bearer origin binding", () => {
	test("allows canonical-equivalent config and rejects a hostile override before fetch", async () => {
		const auth = oauthAuth();
		setAuth(auth);
		setConfig({
			apiUrl: "https://CLOUD.Example.Test:443/",
			deployApiUrl: HOSTED_ORIGIN,
		});
		let requests = 0;
		let authorization = "";
		globalThis.fetch = async (request) => {
			requests += 1;
			authorization = request.headers.get("authorization") ?? "";
			return Response.json({ id: "cloud-user", email: "user@example.test" });
		};
		const matching = new ApiClient();
		unwrap(await matching.GET("/v1/auth/me"));
		expect(requests).toBe(1);
		expect(authorization).toBe(`Bearer ${auth.apiKey}`);

		process.env.CLAWDI_API_URL = "https://attacker.example.test";
		const hostile = new ApiClient();
		await expect(hostile.GET("/v1/auth/me")).rejects.toThrow("bound to Cloud origin");
		expect(requests).toBe(1);
	});

	test("never auto-binds a pre-binding OAuth credential, including production defaults", async () => {
		setAuth(oauthAuth(null));
		setConfig({ apiUrl: PRODUCTION_CLOUD_ORIGIN, deployApiUrl: "https://api.clawdi.ai" });
		let requests = 0;
		globalThis.fetch = async () => {
			requests += 1;
			return Response.json({});
		};
		await expect(new ApiClient().GET("/v1/auth/me")).rejects.toThrow("predates endpoint binding");
		expect(requests).toBe(0);
		expect(getStoredAuth()?.endpointBinding).toBeUndefined();
	});

	test("preserves old API keys only at production Cloud and supports explicit custom binding", async () => {
		setAuth({ apiKey: "legacy-production-secret" });
		expect(await getClawdiAccessToken(PRODUCTION_CLOUD_ORIGIN)).toBe("legacy-production-secret");
		await expect(getClawdiAccessToken(CLOUD_ORIGIN)).rejects.toThrow("re-import it");

		setAuth({
			apiKey: "legacy-custom-secret",
			endpointBinding: { version: 1, cloudApiOrigin: CLOUD_ORIGIN },
		});
		expect(await getClawdiAccessToken("https://CLOUD.Example.Test:443/")).toBe(
			"legacy-custom-secret",
		);
	});

	test("requires an explicit custom origin for environment credentials", async () => {
		process.env.CLAWDI_AUTH_TOKEN = "environment-secret";
		expect(await getClawdiAccessToken(PRODUCTION_CLOUD_ORIGIN)).toBe("environment-secret");
		await expect(getClawdiAccessToken(CLOUD_ORIGIN)).rejects.toThrow(
			"CLAWDI_AUTH_TOKEN is not bound",
		);
		process.env.CLAWDI_AUTH_TOKEN_ORIGIN = "https://CLOUD.Example.Test:443/";
		expect(await getClawdiAccessToken(CLOUD_ORIGIN)).toBe("environment-secret");
		await expect(getClawdiAccessToken("https://attacker.example.test")).rejects.toThrow(
			"bound to Cloud origin",
		);
	});

	test("logout never revokes through a mismatched Cloud origin and still clears local secrets", async () => {
		setAuth(oauthAuth());
		let requests = 0;
		const result = await logoutClawdiCredentials("https://attacker.example.test", {
			fetch: async () => {
				requests += 1;
				return Response.json({ status: "revoked" });
			},
		});
		expect(result).toEqual({
			loggedOut: true,
			remoteRevoked: false,
			environmentCredential: false,
		});
		expect(requests).toBe(0);
		expect(getStoredAuth()).toBeNull();
	});

	test("explicit revoke fails closed on mismatch without deleting the credential", async () => {
		setAuth(oauthAuth());
		let requests = 0;
		await expect(
			revokeClerkOAuthSession("https://attacker.example.test", {
				fetch: async () => {
					requests += 1;
					return Response.json({});
				},
			}),
		).rejects.toThrow("bound to Cloud origin");
		expect(requests).toBe(0);
		expect(getStoredAuth()).not.toBeNull();
	});
});

describe("Hosted shared OAuth profile binding", () => {
	test("rejects a bound legacy Cloud key before Hosted fetch", async () => {
		setAuth({
			apiKey: "clawdi_legacy_secret",
			endpointBinding: { version: 1, cloudApiOrigin: CLOUD_ORIGIN },
		});
		let requests = 0;
		const client = new HostedDeployClient({
			apiBaseUrl: CLOUD_ORIGIN,
			baseUrl: HOSTED_ORIGIN,
			fetch: async () => {
				requests += 1;
				return Response.json([]);
			},
		});
		await expect(client.getPlans()).rejects.toThrow("canonical Clerk OAuth login");
		expect(requests).toBe(0);
	});

	test("uses constructor endpoint snapshots even if environment overrides change later", async () => {
		setAuth(oauthAuth());
		process.env.CLAWDI_API_URL = CLOUD_ORIGIN;
		process.env.CLAWDI_DEPLOY_API_URL = `${HOSTED_ORIGIN}/v2`;
		const urls: string[] = [];
		const client = new HostedDeployClient({
			fetch: async (request) => {
				urls.push(request.url);
				return Response.json([]);
			},
		});
		process.env.CLAWDI_API_URL = "https://attacker-cloud.example.test";
		process.env.CLAWDI_DEPLOY_API_URL = "https://attacker-hosted.example.test";
		await client.getPlans();
		expect(urls).toEqual([`${HOSTED_ORIGIN}/v2/subscription/plans`]);
	});

	test("rejects Hosted mismatch and an auth-file replacement before fetch", async () => {
		setAuth(oauthAuth());
		let requests = 0;
		const mismatched = new HostedDeployClient({
			apiBaseUrl: CLOUD_ORIGIN,
			baseUrl: "https://attacker-hosted.example.test",
			fetch: async () => {
				requests += 1;
				return Response.json([]);
			},
		});
		await expect(mismatched.getPlans()).rejects.toThrow("not bound");
		expect(requests).toBe(0);

		const snapshot = new HostedDeployClient({
			apiBaseUrl: CLOUD_ORIGIN,
			baseUrl: HOSTED_ORIGIN,
			fetch: async () => {
				requests += 1;
				return Response.json([]);
			},
		});
		setAuth(
			oauthAuth({
				version: 1,
				cloudApiOrigin: "https://other-cloud.example.test",
				hostedApiOrigin: "https://other-hosted.example.test",
			}),
		);
		await expect(snapshot.getPlans()).rejects.toThrow("not bound");
		expect(requests).toBe(0);
	});
});

describe("auth status endpoint metadata", () => {
	test("reports only non-secret binding state in JSON", async () => {
		setConfig({ apiUrl: CLOUD_ORIGIN, deployApiUrl: HOSTED_ORIGIN });
		const auth = oauthAuth();
		setAuth(auth);
		const output: string[] = [];
		const priorLog = console.log;
		console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
		try {
			await authStatus({ json: true });
		} finally {
			console.log = priorLog;
		}
		const rendered = output.join("\n");
		const payload: unknown = JSON.parse(rendered);
		expect(payload).toMatchObject({
			schemaVersion: "clawdi.authStatus.v1",
			credentialType: "clerk-oauth",
			endpointBinding: {
				state: "bound",
				cloudApiOrigin: CLOUD_ORIGIN,
				hostedApiOrigin: HOSTED_ORIGIN,
				currentProfileMatches: true,
			},
		});
		expect(rendered).not.toContain(auth.apiKey);
		expect(rendered).not.toContain("oauth-refresh-secret");
	});

	test("redacts malformed configured URLs that contain userinfo", async () => {
		setAuth(oauthAuth());
		process.env.CLAWDI_API_URL = "https://operator-password@attacker.example.test";
		const output: string[] = [];
		const priorLog = console.log;
		console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
		try {
			await authStatus({ json: true });
		} finally {
			console.log = priorLog;
		}
		const rendered = output.join("\n");
		expect(rendered).toContain('"apiUrl": "<invalid>"');
		expect(rendered).not.toContain("operator-password");
	});
});
