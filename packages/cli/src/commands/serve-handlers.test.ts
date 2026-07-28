import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PendingAuth } from "../lib/config";
import { adapterForType } from "../lib/select-adapter";
import { rejectUnsupportedOpts, runDaemonWorkers } from "./serve";

/**
 * Behavior tests for daemon singleton handler behavior:
 *   - rejectUnsupportedOpts (helper used by status/uninstall/restart/logs/doctor)
 *   - singleton daemon handlers rejecting legacy target selectors
 *
 * Strategy: swap `process.exit` to throw a tagged error so we can
 * `expect(...).toThrow()` and inspect the captured `console.error`
 * output. Real listRegisteredAgentTypes / file-system calls are
 * left in place — the test environment has 0 registered agents,
 * which is enough to hit every "rejects before reaching the OS"
 * branch we care about.
 */

const captured = {
	stderr: [] as string[],
	exitCode: null as number | null,
};

class ExitCalled extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
	}
}

function rpcOAuthAccessToken(): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "at+jwt" })}.${encode({
		iss: "https://clerk.example.test",
		client_id: "clawdi-cli",
		aud: "clawdi-api",
		azp: "https://accounts.clawdi.test",
		sub: "rpc-oauth-user",
		exp: Math.floor(Date.now() / 1_000) + 3_600,
	})}.signature`;
}

function rpcPendingAuth(): PendingAuth {
	return {
		authType: "clerk_oauth_pkce",
		state: "rpc-state",
		codeVerifier: "rpc-verifier",
		authorizationUrl: "https://clerk.example.test/oauth/authorize",
		redirectUri: "http://127.0.0.1:18473/oauth/callback",
		issuer: "https://clerk.example.test",
		clientId: "clawdi-cli",
		audience: "clawdi-api",
		authorizedParties: ["https://accounts.clawdi.test"],
		tokenEndpoint: "https://clerk.example.test/oauth/token",
		expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
		apiUrl: "https://cloud.example.test",
		scopes: ["openid", "profile", "email", "offline_access"],
	};
}

let restoreExit: (() => void) | null = null;

beforeEach(() => {
	captured.stderr = [];
	captured.exitCode = null;
	const origExit = process.exit;
	const origErr = console.error;
	process.exit = ((code?: number) => {
		captured.exitCode = code ?? 0;
		throw new ExitCalled(code ?? 0);
	}) as typeof process.exit;
	console.error = (...args: unknown[]) => {
		captured.stderr.push(args.map(String).join(" "));
	};
	restoreExit = () => {
		process.exit = origExit;
		console.error = origErr;
	};
});

afterEach(() => {
	restoreExit?.();
	restoreExit = null;
});

describe("rejectUnsupportedOpts", () => {
	const ALLOWED = new Set(["agent", "json"]);

	it("returns silently when opts only contain allowed keys", () => {
		expect(() => rejectUnsupportedOpts("foo", { agent: "x", json: true }, ALLOWED)).not.toThrow();
		expect(captured.exitCode).toBeNull();
	});

	it("returns silently on empty opts", () => {
		expect(() => rejectUnsupportedOpts("foo", {}, ALLOWED)).not.toThrow();
		expect(captured.exitCode).toBeNull();
	});

	it("exits 1 when an unsupported key is present", () => {
		expect(() =>
			rejectUnsupportedOpts("doctor", { agent: "codex", environmentId: "x" }, new Set(["json"])),
		).toThrow(ExitCalled);
		expect(captured.exitCode).toBe(1);
		// Both offenders surfaced, kebab-cased, in the error.
		const msg = captured.stderr.join("\n");
		expect(msg).toMatch(/daemon doctor/);
		expect(msg).toMatch(/--agent/);
		expect(msg).toMatch(/--environment-id/);
	});

	it("kebab-cases camelCase option names in the error", () => {
		expect(() =>
			rejectUnsupportedOpts("status", { environmentId: "x" }, new Set(["agent"])),
		).toThrow(ExitCalled);
		expect(captured.stderr.join("\n")).toMatch(/--environment-id/);
		expect(captured.stderr.join("\n")).not.toMatch(/--environmentId/);
	});
});

describe("daemon worker ownership", () => {
	it("starts one runtime observation producer for multiple live-sync targets", async () => {
		const adapter = adapterForType("codex");
		if (!adapter) throw new Error("expected codex adapter");
		let producerStarts = 0;
		let engineStarts = 0;
		await runDaemonWorkers({
			targets: [
				{ agentType: "codex", adapter, environmentId: "env-one" },
				{ agentType: "codex", adapter, environmentId: "env-two" },
			],
			abortController: new AbortController(),
			forcePollWatcher: true,
			runObservationProducer: async () => {
				producerStarts += 1;
			},
			runEngine: async () => {
				engineStarts += 1;
			},
		});

		expect(producerStarts).toBe(1);
		expect(engineStarts).toBe(2);
	});

	it("starts the runtime observation producer with liveSync agents=[]", async () => {
		let producerStarts = 0;
		let engineStarts = 0;
		await runDaemonWorkers({
			targets: [],
			abortController: new AbortController(),
			forcePollWatcher: true,
			runObservationProducer: async () => {
				producerStarts += 1;
			},
			runEngine: async () => {
				engineStarts += 1;
			},
		});

		expect(producerStarts).toBe(1);
		expect(engineStarts).toBe(0);
	});
});

describe("subcommand handler rejects parent-leaked options", () => {
	it("install rejects legacy selectors", async () => {
		const { serveInstall } = await import("./serve");
		await expect(serveInstall({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon install.*--agent/);
	});

	it("uninstall rejects legacy selectors", async () => {
		const { serveUninstall } = await import("./serve");
		await expect(serveUninstall({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon uninstall.*--agent/);
	});

	it("restart rejects legacy selectors", async () => {
		const { serveRestart } = await import("./serve");
		await expect(serveRestart({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon restart.*--agent/);
	});

	it("uninstall rejects --environment-id", async () => {
		const { serveUninstall } = await import("./serve");
		await expect(
			serveUninstall({
				environmentId: "00000000-0000-0000-0000-000000000001",
			} as Record<string, unknown>),
		).rejects.toThrow(ExitCalled);
		expect(captured.stderr.join("\n")).toMatch(/daemon uninstall.*--environment-id/);
	});

	it("status rejects --environment-id", async () => {
		const { serveStatus } = await import("./serve");
		await expect(
			serveStatus({
				environmentId: "00000000-0000-0000-0000-000000000001",
			} as Record<string, unknown>),
		).rejects.toThrow(ExitCalled);
		expect(captured.stderr.join("\n")).toMatch(/daemon status.*--environment-id/);
	});

	it("doctor rejects --agent", async () => {
		const { serveDoctor } = await import("./serve");
		await expect(serveDoctor({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon doctor.*--agent/);
	});
});

describe("full control RPC handler surface", () => {
	it("advertises sync, vault, auth, update, and operation RPC methods", async () => {
		const { createControlRpcHandlers } = await import("./serve");
		const handlers = createControlRpcHandlers();
		const methodsResult = (await handlers.methods?.({})) as { methods?: string[] } | undefined;

		expect(methodsResult?.methods).toContain("ping");
		expect(methodsResult?.methods).toContain("status");
		expect(methodsResult?.methods?.some((method) => method.startsWith("daemon."))).toBe(false);
		expect(methodsResult?.methods).toContain("sync.push");
		expect(methodsResult?.methods).toContain("sync.pull");
		expect(methodsResult?.methods).toContain("vault.resolve");
		expect(methodsResult?.methods).toContain("auth.login");
		expect(methodsResult?.methods).toContain("update.install");
		expect(methodsResult?.methods).toContain("operation.status");
	});

	it("requires an explicit cwd, project, or all=true for sync.push", async () => {
		const { createControlRpcHandlers } = await import("./serve");
		const handler = createControlRpcHandlers()["sync.push"];
		if (!handler) throw new Error("missing sync.push handler");

		await expect((async () => handler({}))()).rejects.toThrow(
			"sync.push RPC requires cwd or project unless all=true",
		);
	});

	it("rejects push-only sync params on pull", async () => {
		const { createControlRpcHandlers } = await import("./serve");
		const handler = createControlRpcHandlers()["sync.pull"];
		if (!handler) throw new Error("missing sync.pull handler");

		await expect(
			(async () => handler({ exclude_project: "/tmp/private", wait: true }))(),
		).rejects.toThrow("Unsupported RPC params: exclude_project");
	});

	it("blocks vault plaintext reads unless explicitly confirmed", async () => {
		const { createControlRpcHandlers } = await import("./serve");
		const handler = createControlRpcHandlers()["vault.resolve"];
		if (!handler) throw new Error("missing vault.resolve handler");

		await expect(
			(async () => handler({ key: "OPENAI_API_KEY", include_value: true }))(),
		).rejects.toThrow("vault.resolve plaintext access requires confirm_secret_access=true");
	});

	it("does not allow vault.inject secret rendering in background operation logs", async () => {
		const { createControlRpcHandlers } = await import("./serve");
		const handler = createControlRpcHandlers()["vault.inject"];
		if (!handler) throw new Error("missing vault.inject handler");

		await expect(
			(async () =>
				handler({
					input: "OPENAI_API_KEY=clawdi://prod/openai/key",
					confirm_secret_access: true,
					wait: false,
				}))(),
		).rejects.toThrow("vault.inject secret rendering cannot run as a background operation");
	});

	it("does not overwrite existing auth with an unverified imported API key", async () => {
		const originalClawdiHome = process.env.CLAWDI_HOME;
		const originalToken = process.env.CLAWDI_AUTH_TOKEN;
		const originalFetch = globalThis.fetch;
		const tmpHome = mkdtempSync(join(tmpdir(), "clawdi-rpc-auth-"));
		process.env.CLAWDI_HOME = join(tmpHome, ".clawdi");
		delete process.env.CLAWDI_AUTH_TOKEN;
		globalThis.fetch = Object.assign(async () => new Response("", { status: 401 }), {
			preconnect: originalFetch.preconnect,
		});
		try {
			const [{ createControlRpcHandlers }, { getAuth, setAuth }] = await Promise.all([
				import("./serve"),
				import("../lib/config"),
			]);
			setAuth({ apiKey: "old-key", userId: "old-user", email: "old@example.com" });
			const handler = createControlRpcHandlers()["auth.login"];
			if (!handler) throw new Error("missing auth.login handler");

			await expect(
				(async () =>
					handler({
						api_key: "bad-key",
						replace: true,
						confirm_secret_access: true,
					}))(),
			).rejects.toThrow("API key verification failed with HTTP 401");
			expect(getAuth()?.apiKey).toBe("old-key");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalClawdiHome;
			if (originalToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = originalToken;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it("rejects OAuth auth replacement while existing auth is present", async () => {
		const originalClawdiHome = process.env.CLAWDI_HOME;
		const originalToken = process.env.CLAWDI_AUTH_TOKEN;
		const tmpHome = mkdtempSync(join(tmpdir(), "clawdi-rpc-auth-replace-"));
		process.env.CLAWDI_HOME = join(tmpHome, ".clawdi");
		delete process.env.CLAWDI_AUTH_TOKEN;
		try {
			const [{ createControlRpcHandlers }, { setAuth }] = await Promise.all([
				import("./serve"),
				import("../lib/config"),
			]);
			setAuth({ apiKey: "old-key", userId: "old-user", email: "old@example.com" });
			const handler = createControlRpcHandlers()["auth.login"];
			if (!handler) throw new Error("missing auth.login handler");

			await expect(
				(async () =>
					handler({
						replace: true,
						confirm_secret_access: true,
					}))(),
			).rejects.toThrow("auth.login replace requires api_key");
		} finally {
			if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalClawdiHome;
			if (originalToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = originalToken;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it("keeps auth.complete Cloud verification outcomes explicit and secret-free", async () => {
		const originalClawdiHome = process.env.CLAWDI_HOME;
		const originalToken = process.env.CLAWDI_AUTH_TOKEN;
		const originalFetch = globalThis.fetch;
		const tmpHome = mkdtempSync(join(tmpdir(), "clawdi-rpc-oauth-complete-"));
		process.env.CLAWDI_HOME = join(tmpHome, ".clawdi");
		delete process.env.CLAWDI_AUTH_TOKEN;
		try {
			const [{ createControlRpcHandlers }, config] = await Promise.all([
				import("./serve"),
				import("../lib/config"),
			]);
			const handler = createControlRpcHandlers()["auth.complete"];
			if (!handler) throw new Error("missing auth.complete handler");

			for (const cloudCase of [
				"verified",
				"server_error",
				"network",
				"rejected",
				"forbidden",
				"malformed",
			] as const) {
				config.clearAuth();
				config.setPendingAuth(rpcPendingAuth());
				const paths: string[] = [];
				globalThis.fetch = Object.assign(
					async (input: RequestInfo | URL) => {
						const request = input instanceof Request ? input : new Request(input);
						const path = new URL(request.url).pathname;
						paths.push(path);
						if (path === "/oauth/token") {
							return Response.json({
								access_token: rpcOAuthAccessToken(),
								refresh_token: `refresh-${cloudCase}-secret`,
								token_type: "Bearer",
								scope: "openid profile email offline_access",
							});
						}
						if (path === "/v1/auth/me") {
							if (cloudCase === "network") {
								throw new TypeError("private network detail");
							}
							if (cloudCase === "server_error") {
								return new Response("private server detail", { status: 503 });
							}
							if (cloudCase === "rejected") {
								return new Response("private rejection detail", { status: 401 });
							}
							if (cloudCase === "forbidden") {
								return new Response("private forbidden detail", { status: 403 });
							}
							return cloudCase === "malformed"
								? Response.json({ email: "missing-id@example.test" })
								: Response.json({
										id: "rpc-cloud-user",
										email: "rpc@example.test",
										name: "RPC User",
									});
						}
						if (path === "/v1/cli/auth/oauth/revoke") {
							return Response.json({ status: "revoked" });
						}
						return new Response("unexpected", { status: 404 });
					},
					{ preconnect: originalFetch.preconnect },
				);

				let result: unknown;
				let caught: unknown;
				try {
					result = await handler({
						callback_url: "http://127.0.0.1:18473/oauth/callback?code=rpc-code&state=rpc-state",
						confirm_secret_access: true,
					});
				} catch (error) {
					caught = error;
				}

				if (cloudCase === "verified") {
					expect(result).toMatchObject({
						status: "logged_in",
						cloud_verified: true,
						user: { id: "rpc-cloud-user" },
					});
					expect(config.getStoredAuth()).toMatchObject({ userId: "rpc-cloud-user" });
				} else if (cloudCase === "server_error" || cloudCase === "network") {
					expect(result).toEqual({
						status: "cloud_unverified",
						cloud_verified: false,
						reason: cloudCase === "network" ? "network" : "server_error",
						...(cloudCase === "server_error" ? { http_status: 503 } : {}),
					});
					expect(config.getStoredAuth()).toMatchObject({
						refreshToken: `refresh-${cloudCase}-secret`,
					});
				} else {
					expect(caught).toBeInstanceOf(Error);
					expect(config.getStoredAuth()).toBeNull();
					expect(paths).toContain("/v1/cli/auth/oauth/revoke");
				}
				expect(config.getPendingAuth()).toBeNull();
				expect(JSON.stringify(result ?? caught)).not.toContain(`refresh-${cloudCase}-secret`);
			}
		} finally {
			globalThis.fetch = originalFetch;
			if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalClawdiHome;
			if (originalToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = originalToken;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});

describe("daemon HTTP RPC listener safety", () => {
	it("rejects non-loopback listen hosts unless explicitly allowed", async () => {
		const { serve } = await import("./serve");

		await expect(
			serve({ host: "0.0.0.0", port: "17654" } as Record<string, unknown>),
		).rejects.toThrow("Refusing to listen on non-loopback HTTP RPC host 0.0.0.0");
	});

	it("allows a loopback listen host without an explicit port before continuing to the auth gate", async () => {
		const { serve } = await import("./serve");

		await expect(serve({ host: "127.0.0.1" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
	});

	it("allows explicit non-loopback opt-in before continuing to the auth gate", async () => {
		const originalHome = process.env.CLAWDI_HOME;
		const originalToken = process.env.CLAWDI_AUTH_TOKEN;
		const tmpHome = mkdtempSync(join(tmpdir(), "clawdi-rpc-listen-"));
		process.env.CLAWDI_HOME = join(tmpHome, ".clawdi");
		delete process.env.CLAWDI_AUTH_TOKEN;
		try {
			const { serve } = await import("./serve");
			await expect(
				serve({
					host: "0.0.0.0",
					port: "17654",
					allowRemote: true,
				} as Record<string, unknown>),
			).rejects.toThrow(ExitCalled);
		} finally {
			if (originalHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalHome;
			if (originalToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = originalToken;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});

describe("legacy daemon run migration", () => {
	it("installs the singleton unit, persists an explicit env id, and removes the old unit", async () => {
		if (process.platform !== "linux") return;

		const originalHome = process.env.HOME;
		const originalClawdiHome = process.env.CLAWDI_HOME;
		const originalPath = process.env.PATH;
		const originalToken = process.env.CLAWDI_AUTH_TOKEN;
		const originalArgv1 = process.argv[1];
		const tmpHome = mkdtempSync(join(tmpdir(), "clawdi-legacy-daemon-"));
		const stubBin = join(tmpHome, "bin");
		const fakeEntry = join(tmpHome, "clawdi-bin");
		const singletonUnit = join(tmpHome, ".config", "systemd", "user", "clawdi-serve.service");
		const legacyUnit = join(tmpHome, ".config", "systemd", "user", "clawdi-serve-codex.service");
		try {
			process.env.HOME = tmpHome;
			delete process.env.CLAWDI_HOME;
			process.env.CLAWDI_AUTH_TOKEN = "clawdi_test_token";
			mkdirSync(stubBin, { recursive: true });
			writeExecutable(join(stubBin, "systemctl"), "#!/bin/sh\nexit 0\n");
			process.env.PATH = `${stubBin}:${originalPath ?? ""}`;
			writeExecutable(fakeEntry, "#!/bin/sh\nexit 0\n");
			process.argv[1] = fakeEntry;
			mkdirSync(dirname(legacyUnit), { recursive: true });
			writeFileSync(legacyUnit, "legacy unit\n");

			const { serve } = await import("./serve");
			await expect(
				serve({
					agent: "codex",
					environmentId: "env-codex",
				} as Record<string, unknown>),
			).rejects.toThrow(ExitCalled);

			expect(captured.exitCode).toBe(0);
			expect(existsSync(singletonUnit)).toBe(true);
			expect(existsSync(legacyUnit)).toBe(false);
			expect(
				readFileSync(join(tmpHome, ".clawdi", "environments", "codex.json"), "utf-8"),
			).toContain('"id": "env-codex"');
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalClawdiHome;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = originalToken;
			process.argv[1] = originalArgv1 ?? "";
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
}
