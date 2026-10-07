import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import {
	authComplete,
	authLogin,
	authLoginDesktop,
	browserOpenCommand,
} from "../../src/commands/auth";
import * as browser from "../../src/lib/browser";
import {
	clearAuth,
	getAuth,
	getPendingAuth,
	type PendingAuth,
	setAuth,
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
const nativeFetch = globalThis.fetch;

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
		authType: "clerk_oauth_device",
		state: "interactive-state",
		deviceCode: "private-device-code",
		userCode: "ABCD-EFGH",
		verificationUri: "https://accounts.example.test/device",
		verificationUriComplete: "https://accounts.example.test/device?user_code=ABCD-EFGH",
		interval: 1,
		issuer: "https://clerk.example.test",
		clientId: "clawdi-cli",
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

const stdout: string[] = [];
const stderr: string[] = [];
let openSpy: ReturnType<typeof spyOn<typeof browser, "openInBrowser">>;
let stdoutSpy: ReturnType<typeof spyOn<typeof console, "log">>;
let stderrSpy: ReturnType<typeof spyOn<typeof console, "error">>;
let writeSpy: ReturnType<typeof spyOn<typeof process.stderr, "write">>;
let ttyDescriptors: { input?: PropertyDescriptor; output?: PropertyDescriptor };
let sshEnv: Record<string, string | undefined>;

function setTty(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

function tokenHandler() {
	return {
		method: "POST",
		path: "/oauth/token",
		response: () =>
			jsonResponse({
				access_token: oauthAccessToken(),
				refresh_token: "refresh-secret",
				token_type: "Bearer",
				expires_in: 3600,
				scope: "openid profile email offline_access",
			}),
	};
}

function profileHandler() {
	return {
		method: "GET",
		path: "/v1/auth/me",
		response: () => jsonResponse({ id: "cloud-user", email: "user@example.test", name: "User" }),
	};
}

function startHandlers(desktop = false) {
	return [
		{
			method: "GET",
			path: "/v1/cli/auth/oauth/config",
			response: () =>
				jsonResponse({
					issuer: "https://clerk.example.test",
					client_id: "clawdi-cli",
					authorized_parties: ["https://accounts.clawdi.test"],
					redirect_uri: desktop ? "http://127.0.0.1:18473/oauth/callback" : "ignored",
				}),
		},
		{
			method: "GET",
			path: "/.well-known/oauth-authorization-server",
			response: () =>
				jsonResponse({
					issuer: "https://clerk.example.test",
					device_authorization_endpoint: "https://clerk.example.test/oauth/device_authorization",
					token_endpoint: "https://clerk.example.test/oauth/token",
					grant_types_supported: desktop
						? ["authorization_code", "refresh_token"]
						: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
					authorization_endpoint: "https://clerk.example.test/oauth/authorize",
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				}),
		},
		{
			method: "POST",
			path: "/oauth/device_authorization",
			response: () =>
				jsonResponse({
					device_code: "private-device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://accounts.example.test/device",
					verification_uri_complete: "https://accounts.example.test/device?user_code=ABCD-EFGH",
					expires_in: 600,
					interval: 1,
				}),
		},
	];
}

function simulateDesktopCallback(error?: string): Promise<Response>[] {
	const responses: Promise<Response>[] = [];
	openSpy.mockImplementation((authorizationUrl) => {
		const url = new URL(authorizationUrl);
		const redirect = url.searchParams.get("redirect_uri");
		const state = url.searchParams.get("state");
		if (!redirect || !state) throw new Error("Expected PKCE authorization URL");
		const callback = new URL(redirect);
		callback.search = new URLSearchParams({
			state,
			...(error ? { error } : { code: "private-code" }),
		}).toString();
		responses.push(nativeFetch(callback));
	});
	return responses;
}

beforeEach(() => {
	stdout.length = 0;
	stderr.length = 0;
	openSpy = spyOn(browser, "openInBrowser").mockImplementation(() => {});
	stdoutSpy = spyOn(console, "log").mockImplementation((...args) => {
		stdout.push(args.map(String).join(" "));
	});
	stderrSpy = spyOn(console, "error").mockImplementation((...args) => {
		stderr.push(args.map(String).join(" "));
	});
	writeSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr.push(String(chunk));
		return true;
	});
	ttyDescriptors = {
		input: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
		output: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
	};
	setTty(false);
	sshEnv = {};
	for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
		sshEnv[key] = process.env[key];
		delete process.env[key];
	}
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
	process.exitCode = 0;
});

afterEach(() => {
	openSpy.mockRestore();
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	writeSpy.mockRestore();
	if (ttyDescriptors.input) Object.defineProperty(process.stdin, "isTTY", ttyDescriptors.input);
	else delete process.stdin.isTTY;
	if (ttyDescriptors.output) Object.defineProperty(process.stdout, "isTTY", ttyDescriptors.output);
	else delete process.stdout.isTTY;
	for (const [key, value] of Object.entries(sshEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
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
	it.each([200, 410])("manual login only verifies an existing key (HTTP %s)", async (status) => {
		clearAuth();
		setTty(true);
		const passwordSpy = spyOn(prompts, "password").mockResolvedValue("clawdi_existing");
		const messageSpy = spyOn(prompts.log, "message").mockImplementation(() => {});
		const detail =
			"This sign-in method is no longer supported. Update the Clawdi CLI and run `clawdi auth login`.";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/auth/me",
				response: () =>
					status === 200 ? profileHandler().response() : jsonResponse({ detail }, status),
			},
		]);
		try {
			await authLogin({ manual: true });
			expect(passwordSpy.mock.calls[0]?.[0].message).toBe("Paste an existing API key");
			const messages = messageSpy.mock.calls.map(([message]) => String(message));
			expect(messages.join("\n")).toContain("API keys can no longer be created");
			expect(messages.join("\n")).toContain("clawdi auth login");
			expect(messages.join("\n")).toContain("--no-open");
			if (status === 410) expect(messages.join("\n")).toContain(detail);
		} finally {
			passwordSpy.mockRestore();
			messageSpy.mockRestore();
			restore();
		}
		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /v1/auth/me",
		]);
		expect(openSpy).not.toHaveBeenCalled();
		if (status === 200) {
			expect(getAuth()).toMatchObject({ apiKey: "clawdi_existing", userId: "cloud-user" });
			expect(process.exitCode).toBe(0);
		} else {
			expect(getAuth()).toBeNull();
			expect(process.exitCode).toBe(1);
		}
	});

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

	it("non-TTY login prints link and code, persists private pending state, and polls to a verified credential", async () => {
		clearAuth();
		let polls = 0;
		const { captured, restore } = mockFetch([
			...startHandlers(),
			{
				method: "POST",
				path: "/oauth/token",
				response: () => {
					const saved = getPendingAuth();
					expect(saved?.authType).toBe("clerk_oauth_device");
					expect(statSync(join(tmpHome, ".clawdi", "pending-auth.json")).mode & 0o777).toBe(0o600);
					return ++polls === 1
						? jsonResponse({ error: "authorization_pending" }, 400)
						: tokenHandler().response();
				},
			},
			profileHandler(),
		]);
		try {
			await authLogin();
		} finally {
			restore();
		}
		expect(openSpy).not.toHaveBeenCalled();
		expect(stdout.join("\n")).toContain(
			"Open:  https://accounts.example.test/device?user_code=ABCD-EFGH",
		);
		expect(stdout.join("\n")).toContain("Code:  ABCD-EFGH");
		expect(stdout.join("\n")).toContain("check that the page shows the same code");
		expect(stdout.join("\n")).toContain(
			"Approve only if you started this sign-in on this machine just now",
		);
		expect(stdout.join("\n")).toContain("Signed in as user@example.test");
		expect(stdout.concat(stderr).join("\n")).not.toContain("private-device-code");
		expect(getPendingAuth()).toBeNull();
		expect(getAuth()).toMatchObject({
			authType: "clerk_oauth",
			userId: "cloud-user",
			refreshToken: "refresh-secret",
		});
		expect(captured.map((request) => request.path)).toEqual([
			"/v1/cli/auth/oauth/config",
			"/.well-known/oauth-authorization-server",
			"/oauth/device_authorization",
			"/oauth/token",
			"/oauth/token",
			"/v1/auth/me",
		]);
	});

	it.each(["open", "no-open", "ssh"])(
		"TTY %s uses device authorization with the right browser behavior",
		async (mode) => {
			clearAuth();
			setTty(true);
			if (mode === "ssh") process.env.SSH_CONNECTION = "fake-ssh";
			const { restore } = mockFetch([...startHandlers(), tokenHandler(), profileHandler()]);
			try {
				await authLogin({ open: mode !== "no-open" });
			} finally {
				restore();
			}
			if (mode === "open")
				expect(openSpy).toHaveBeenCalledWith(
					"https://accounts.example.test/device?user_code=ABCD-EFGH",
				);
			else expect(openSpy).not.toHaveBeenCalled();
			expect(stderr.join("\n")).toContain("ABCD-EFGH");
			expect(stdout).toEqual([]);
		},
	);

	it("auth complete resumes persisted device authorization without stdin", async () => {
		clearAuth();
		setPendingAuth(oauthPending());
		const { restore } = mockFetch([tokenHandler(), profileHandler()]);
		try {
			await authComplete();
		} finally {
			restore();
		}
		expect(getPendingAuth()).toBeNull();
		expect(getAuth()?.userId).toBe("cloud-user");
		expect(stdout.join("\n")).toContain("ABCD-EFGH");
		expect(openSpy).not.toHaveBeenCalled();
	});

	it("reports missing and expired device authorization", async () => {
		clearAuth();
		await authComplete();
		expect(stderr.join("\n")).toContain("No pending sign-in");
		setPendingAuth({ ...oauthPending(), expiresAt: new Date(Date.now() - 1).toISOString() });
		await authComplete();
		expect(getPendingAuth()).toBeNull();
		expect(process.exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("The code expired");
	});

	it.each([
		"access_denied",
		"expired_token",
		"unauthorized_client",
		"unsupported_grant_type",
		"invalid_grant",
	])("clears pending state after %s", async (error) => {
		clearAuth();
		setPendingAuth(oauthPending());
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/oauth/token",
				response: () => jsonResponse({ error, error_description: "private-device-code" }, 400),
			},
		]);
		try {
			await authComplete();
		} finally {
			restore();
		}
		expect(getPendingAuth()).toBeNull();
		expect(getAuth()).toBeNull();
		expect(process.exitCode).toBe(1);
		expect(stdout.concat(stderr).join("\n")).not.toContain("private-device-code");
	});

	it("reports success when a concurrent device poll already committed the same Cloud account", async () => {
		clearAuth();
		setPendingAuth(oauthPending());
		const pending = oauthPending();
		const { restore } = mockFetch([
			tokenHandler(),
			{
				method: "GET",
				path: "/v1/auth/me",
				response: () => {
					setAuth({
						authType: "clerk_oauth",
						apiKey: oauthAccessToken(),
						refreshToken: "concurrent-refresh",
						accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
						issuer: pending.issuer,
						clientId: pending.clientId,
						tokenEndpoint: pending.tokenEndpoint,
						scopes: pending.scopes,
						userId: "cloud-user",
						email: "user@example.test",
						endpointBinding: pending.endpointBinding,
					});
					return profileHandler().response();
				},
			},
			{
				method: "POST",
				path: "/v1/cli/auth/oauth/revoke",
				response: () => jsonResponse({ status: "revoked" }),
			},
		]);
		try {
			await authComplete();
		} finally {
			restore();
		}
		expect(process.exitCode).toBe(0);
		expect(getAuth()).toMatchObject({ refreshToken: "concurrent-refresh" });
		expect(stdout.join("\n")).toContain("Signed in as user@example.test");
	});

	it("Desktop opens PKCE authorization and preserves exactly one success JSON object", async () => {
		const callbacks = simulateDesktopCallback();
		clearAuth();
		const { restore } = mockFetch([...startHandlers(true), tokenHandler(), profileHandler()]);
		try {
			await authLoginDesktop();
			await Promise.all(callbacks);
		} finally {
			restore();
		}
		const authorization = new URL(openSpy.mock.calls[0]?.[0] ?? "");
		expect(authorization.origin).toBe("https://clerk.example.test");
		expect(authorization.pathname).toBe("/oauth/authorize");
		expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
		expect(stdout).toHaveLength(1);
		expect(JSON.parse(stdout[0] ?? "")).toEqual({
			schemaVersion: "clawdi.desktopLogin.v1",
			status: "authenticated",
			user: { id: "cloud-user", email: "user@example.test" },
		});
		expect(stderr).toHaveLength(1);
		expect(JSON.parse(stderr[0] ?? "")).toMatchObject({
			schemaVersion: "clawdi.desktopLogin.progress.v1",
		});
		const logs = stdout.concat(stderr).join("\n");
		for (const value of [
			"private-code",
			"refresh-secret",
			oauthAccessToken(),
			authorization.searchParams.get("state") ?? "missing",
		])
			expect(logs).not.toContain(value);
		expect(getPendingAuth()).toBeNull();
	});
	it("Desktop reuses an existing Clerk session unless force requests new authorization", async () => {
		const callbacks = simulateDesktopCallback();
		clearAuth();
		const { captured, restore } = mockFetch([
			...startHandlers(true),
			tokenHandler(),
			profileHandler(),
		]);
		try {
			await authLoginDesktop();
			const requestsAfterLogin = captured.length;
			stdout.length = 0;
			stderr.length = 0;
			openSpy.mockClear();
			await authLoginDesktop();
			expect(captured).toHaveLength(requestsAfterLogin);
			expect(openSpy).not.toHaveBeenCalled();
			expect(stderr).toEqual([]);
			expect(stdout).toHaveLength(1);
			stdout.length = 0;
			await authLoginDesktop({ force: true });
			expect(captured).toHaveLength(requestsAfterLogin * 2);
			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(stdout).toHaveLength(1);
			expect(stderr).toHaveLength(1);
			await Promise.all(callbacks);
		} finally {
			restore();
		}
	});
	it("Desktop maps access_denied to cancellation without requesting or persisting tokens", async () => {
		clearAuth();
		const callbacks = simulateDesktopCallback("access_denied");
		const { captured, restore } = mockFetch(startHandlers(true));
		try {
			await authLoginDesktop();
			await Promise.all(callbacks);
		} finally {
			restore();
		}
		expect(stdout).toHaveLength(1);
		expect(JSON.parse(stdout[0] ?? "")).toEqual({
			schemaVersion: "clawdi.desktopLogin.v1",
			status: "cancelled",
		});
		expect(captured.map((request) => request.path)).toEqual([
			"/v1/cli/auth/oauth/config",
			"/.well-known/oauth-authorization-server",
		]);
		expect(getAuth()).toBeNull();
		expect(getPendingAuth()).toBeNull();
	});
});

describe("interactive OAuth Cloud verification boundary", () => {
	it("persists both verified and explicitly cloud-unverified grants without fake profile data", async () => {
		await addToken({
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
							expires_in: 3600,
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
				await authComplete();
				expect(process.exitCode, stderr.join("\n")).not.toBe(1);
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
					: { refreshToken: `refresh-${cloudCase}`, userId: "" },
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
							expires_in: 3600,
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
				await authComplete();
				expect(process.exitCode).toBe(1);
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
