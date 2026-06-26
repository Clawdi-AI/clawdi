import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	aiProviderAddCommand,
	aiProviderCompleteOAuthCommand,
	aiProviderConnectCommand,
	aiProviderEditCommand,
	aiProviderExportCommand,
	aiProviderImportAuthCommand,
	aiProviderImportCommand,
	aiProviderListCommand,
	aiProviderMaterializeAuthCommand,
	aiProviderRemoveCommand,
	aiProviderTestCommand,
	aiProviderValidateCommand,
} from "../../src/commands/ai-provider";
import {
	aiProviderApplyCommand,
	aiProviderStatusCommand,
} from "../../src/commands/ai-provider-apply";
import { aiProviderCatalogPath } from "../../src/lib/ai-provider-catalog";
import { buildAgentTargetProjection } from "../../src/lib/ai-provider-projection";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origApiUrl: string | undefined;
let origPath: string | undefined;
let origCodexHome: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	origPath = process.env.PATH;
	origCodexHome = process.env.CODEX_HOME;
	tmpHome = join(tmpdir(), `clawdi-ai-provider-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://api.test";
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	delete process.env.CLAWDI_HOME;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origClawdiHome) process.env.CLAWDI_HOME = origClawdiHome;
	else delete process.env.CLAWDI_HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	if (origPath) process.env.PATH = origPath;
	else delete process.env.PATH;
	if (origCodexHome) process.env.CODEX_HOME = origCodexHome;
	else delete process.env.CODEX_HOME;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("ai-provider commands", () => {
	it("adds and lists a provider without printing secret values", async () => {
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderListCommand();
		} finally {
			restore();
		}

		expect(existsSync(aiProviderCatalogPath())).toBe(true);
		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.providers[0].id).toBe("openai-main");
		expect(catalog.providers[0].base_url).toBe("https://api.openai.com/v1");
		expect(output()).toContain("env:OPENAI_API_KEY");
		expect(output()).not.toContain("sk-");
	});

	it("allows no-auth localhost but refuses no-auth public URLs", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("local", {
				type: "custom_openai_compatible",
				baseUrl: "http://127.0.0.1:1234/v1",
				apiMode: "openai_chat",
				auth: "none",
				json: true,
			});
			await aiProviderValidateCommand("local", { json: true });
			await expect(
				aiProviderAddCommand("public", {
					type: "custom_openai_compatible",
					baseUrl: "https://example.com/v1",
					apiMode: "openai_chat",
					auth: "none",
					json: true,
				}),
			).rejects.toThrow("public URL");
		} finally {
			restore();
		}
	});

	it("protects defaults on remove unless forced", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				setDefault: true,
				json: true,
			});
			await expect(aiProviderRemoveCommand("openai-main")).rejects.toThrow("Pass --force");
			await aiProviderRemoveCommand("openai-main", { force: true, json: true });
		} finally {
			restore();
		}
		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.providers).toEqual([]);
	});

	it("imports a Codex auth profile through ai-provider auth and redacts output", async () => {
		mkdirSync(join(tmpHome, ".codex"), { recursive: true });
		writeFileSync(join(tmpHome, ".codex", "auth.json"), JSON.stringify({ token: "codex-secret" }));
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: "/api/ai-providers/openai-codex/auth/import",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth: {
							type: "agent_profile",
							tool: "codex",
							profile: "default",
						},
					}),
			},
			{
				method: "POST",
				path: "/api/ai-providers",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
					}),
			},
		]);
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderImportAuthCommand("openai-codex", {
				tool: "codex",
				yes: true,
			});
		} finally {
			restore();
			restoreFetch();
		}

		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.providers[0].auth).toEqual({
			type: "agent_profile",
			tool: "codex",
			profile: "default",
		});
		expect(captured).toHaveLength(2);
		expect(captured[0].body).toMatchObject({ provider_id: "openai-codex" });
		expect(captured[1].body).toMatchObject({
			type: "agent_profile",
			tool: "codex",
			profile: "default",
		});
		expect(output()).not.toContain("codex-secret");
	});

	it("keeps non-Codex auth profiles out of AI Provider v1", async () => {
		const { restore } = captureConsole();
		try {
			await expect(
				aiProviderAddCommand("anthropic-profile", {
					type: "anthropic",
					defaultModel: "claude-opus-4-6",
					auth: "agent:claude-code/default",
					json: true,
				}),
			).rejects.toThrow("Codex only");
			await expect(
				aiProviderAddCommand("openai-oauth", {
					type: "openai",
					defaultModel: "gpt-5.2",
					auth: "oauth:codex/default",
					json: true,
				}),
			).rejects.toThrow("Direct oauth_profile auth is not supported");
			await aiProviderAddCommand("anthropic-main", {
				type: "anthropic",
				defaultModel: "claude-opus-4-6",
				auth: "env:ANTHROPIC_API_KEY",
				json: true,
			});
			await expect(
				aiProviderImportAuthCommand("anthropic-main", {
					tool: "claude-code",
					yes: true,
				}),
			).rejects.toThrow("Codex only");
			writeFileSync(
				aiProviderCatalogPath(),
				JSON.stringify(
					{
						schema_version: 1,
						providers: [
							{
								id: "anthropic-profile",
								type: "anthropic",
								base_url: "https://api.anthropic.com",
								default_model: "claude-opus-4-6",
								auth: {
									type: "agent_profile",
									tool: "claude-code",
									profile: "default",
								},
							},
						],
					},
					null,
					2,
				),
			);
			await expect(aiProviderMaterializeAuthCommand("anthropic-profile")).rejects.toThrow(
				"Codex only",
			);
		} finally {
			restore();
		}
	});

	it("starts provider OAuth through the backend link flow", async () => {
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: "/api/ai-providers/openai-codex/auth/oauth/start",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						oauth_provider: "codex",
						profile: "default",
						auth_url: "https://oauth.example/authorize?state=state-123",
						state: "state-123",
						redirect_uri: "https://cloud.example/oauth/callback",
						expires_at: "2026-06-01T00:10:00Z",
					}),
			},
			{
				method: "POST",
				path: "/api/ai-providers",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
					}),
			},
		]);
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderConnectCommand("openai-codex", { json: true });
		} finally {
			restore();
			restoreFetch();
		}

		expect(captured[0].body).toMatchObject({ provider_id: "openai-codex" });
		expect(captured[1].body).toMatchObject({
			provider: "codex",
			redirect_uri: "http://localhost:1455/auth/callback",
		});
		expect(output()).toContain('"auth_url": "https://oauth.example/authorize?state=state-123"');
		expect(output()).not.toContain("codex login");
	});

	it("rejects unsupported Claude Code OAuth in the first AI Provider auth release", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("anthropic-main", {
				type: "anthropic",
				defaultModel: "claude-opus-4-6",
				auth: "env:ANTHROPIC_API_KEY",
				json: true,
			});
			await expect(
				aiProviderConnectCommand("anthropic-main", {
					tool: "claude-code",
					json: true,
				}),
			).rejects.toThrow("Codex only");
		} finally {
			restore();
		}
	});

	it("listens for a loopback OAuth callback and completes through the backend", async () => {
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: "/api/ai-providers/openai-codex/auth/oauth/start",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						oauth_provider: "codex",
						profile: "default",
						auth_url: "https://oauth.example/authorize?state=state-123",
						state: "state-123",
						redirect_uri: "http://127.0.0.1/callback",
						expires_at: "2026-06-01T00:10:00Z",
					}),
			},
			{
				method: "POST",
				path: "/api/ai-providers/openai-codex/auth/oauth/complete",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth: {
							type: "agent_profile",
							tool: "codex",
							profile: "default",
						},
					}),
			},
			{
				method: "POST",
				path: "/api/ai-providers",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
					}),
			},
		]);
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			const run = aiProviderConnectCommand("openai-codex", {
				open: false,
				timeout: "5",
			});
			const redirectUri = await waitForStartRedirectUri(captured);
			await requestLocalCallback(`${redirectUri}?code=oauth-code&state=state-123`);
			await run;
		} finally {
			restore();
			restoreFetch();
		}

		expect(captured[1].body).toMatchObject({
			provider: "codex",
		});
		const startRedirectUri = String((captured[1].body as { redirect_uri?: string }).redirect_uri);
		expect(startRedirectUri).toMatch(/^http:\/\/localhost:145[57]\/auth\/callback$/);
		expect(captured[2].body).toMatchObject({
			code: "oauth-code",
			state: "state-123",
			redirect_uri: (captured[1].body as { redirect_uri?: string }).redirect_uri,
		});
		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.providers[0].auth).toEqual({
			type: "agent_profile",
			tool: "codex",
			profile: "default",
		});
	});

	it("falls back to the Codex secondary loopback port when the primary port is busy", async () => {
		const occupied = await occupyLoopbackPort(1455);
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: "/api/ai-providers/openai-codex/auth/oauth/start",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						oauth_provider: "codex",
						profile: "default",
						auth_url: "https://oauth.example/authorize?state=state-123",
						state: "state-123",
						redirect_uri: "http://localhost:1457/auth/callback",
						expires_at: "2026-06-01T00:10:00Z",
					}),
			},
			{
				method: "POST",
				path: "/api/ai-providers/openai-codex/auth/oauth/complete",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth: {
							type: "agent_profile",
							tool: "codex",
							profile: "default",
						},
					}),
			},
			{
				method: "POST",
				path: "/api/ai-providers",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
					}),
			},
		]);
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			const run = aiProviderConnectCommand("openai-codex", {
				open: false,
				timeout: "5",
			});
			const redirectUri = await waitForStartRedirectUri(captured);
			expect(redirectUri).toBe("http://localhost:1457/auth/callback");
			await requestLocalCallback(`${redirectUri}?code=oauth-code&state=state-123`);
			await run;
		} finally {
			restore();
			restoreFetch();
			await closeServer(occupied);
		}
	});

	it("completes provider OAuth from a pasted redirect URL", async () => {
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: "/api/ai-providers/openai-codex/auth/oauth/complete",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth: {
							type: "agent_profile",
							tool: "codex",
							profile: "default",
						},
					}),
			},
		]);
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderCompleteOAuthCommand("openai-codex", {
				redirectUrl: "http://127.0.0.1:12345/callback?code=oauth-code&state=state-123",
				json: true,
			});
		} finally {
			restore();
			restoreFetch();
		}

		expect(captured[0].body).toMatchObject({
			code: "oauth-code",
			state: "state-123",
		});
	});

	it("reports loopback OAuth provider errors without completing auth", async () => {
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: "/api/ai-providers/openai-codex/auth/oauth/start",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						oauth_provider: "codex",
						profile: "default",
						auth_url: "https://oauth.example/authorize?state=state-123",
						state: "state-123",
						redirect_uri: "http://127.0.0.1/callback",
						expires_at: "2026-06-01T00:10:00Z",
					}),
			},
			{
				method: "POST",
				path: "/api/ai-providers",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
					}),
			},
		]);
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			const run = aiProviderConnectCommand("openai-codex", {
				open: false,
				timeout: "5",
			});
			const runError = run.then(
				() => undefined,
				(error: unknown) => error,
			);
			const redirectUri = await waitForStartRedirectUri(captured);
			await requestLocalCallback(
				`${redirectUri}?error=access_denied&error_description=No%20thanks`,
			);
			const error = await runError;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("OAuth provider returned access_denied: No thanks");
		} finally {
			restore();
			restoreFetch();
		}

		expect(
			captured.some(
				(request) => request.path === "/api/ai-providers/openai-codex/auth/oauth/complete",
			),
		).toBe(false);
		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.providers[0].auth).toEqual({
			type: "secret_ref",
			ref: "env:OPENAI_API_KEY",
		});
	});

	it("probes provider metadata directly without printing the API key", async () => {
		process.env.OPENAI_API_KEY = "sk-test-secret";
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "GET",
				path: "/v1/models",
				response: () => jsonResponse({ data: [] }),
			},
		]);
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderTestCommand("openai-main", { live: true, json: true });
		} finally {
			restore();
			restoreFetch();
			delete process.env.OPENAI_API_KEY;
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe("https://api.openai.com/v1/models");
		expect(captured[0].headers.authorization).toBe("Bearer sk-test-secret");
		expect(output()).toContain('"status": "ok"');
		expect(output()).not.toContain("sk-test-secret");
	});

	it("checks auth by default without running a live provider probe", async () => {
		process.env.OPENAI_API_KEY = "sk-test-secret";
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "GET",
				path: "/v1/models",
				response: () => jsonResponse({ data: [] }),
			},
		]);
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderTestCommand("openai-main", { json: true });
		} finally {
			restore();
			restoreFetch();
			delete process.env.OPENAI_API_KEY;
		}

		expect(captured).toHaveLength(0);
		expect(output()).toContain('"status": "available"');
		expect(output()).toContain("live probe disabled");
		expect(output()).not.toContain("sk-test-secret");
	});

	it("resolves clawdi vault refs before direct provider probes without printing secrets", async () => {
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: /^\/api\/vault\/resolve/,
				response: () =>
					jsonResponse({
						reference: "clawdi://default/openai/api_key",
						source_project_id: "project-1",
						source_alias: "default",
						value: "sk-vault-secret",
					}),
			},
			{
				method: "GET",
				path: "/v1/models",
				response: () => jsonResponse({ data: [] }),
			},
		]);
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "clawdi://default/openai/api_key",
				agentEnv: "OPENAI_API_KEY",
				json: true,
			});
			await aiProviderTestCommand("openai-main", { live: true, json: true });
		} finally {
			restore();
			restoreFetch();
		}

		expect(captured.map((request) => request.path)).toContain(
			"/api/vault/resolve?vault_slug=default&section=openai&field=api_key",
		);
		const providerProbe = captured.find((request) => request.path === "/v1/models");
		expect(providerProbe?.headers.authorization).toBe("Bearer sk-vault-secret");
		expect(output()).toContain('"status": "ok"');
		expect(output()).toContain("clawdi://...");
		expect(output()).not.toContain("sk-vault-secret");
	});

	it("resolves managed provider api keys through the CLI-only backend route", async () => {
		const catalogPath = join(tmpHome, "providers.json");
		writeFileSync(
			catalogPath,
			JSON.stringify({
				schema_version: 1,
				providers: [
					{
						id: "openai-main",
						type: "openai",
						base_url: "https://api.openai.com/v1",
						default_model: "gpt-5.2",
						auth: {
							type: "api_key",
							source: "managed",
						},
						runtime_env_name: "OPENAI_API_KEY",
					},
				],
			}),
		);
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: "/api/ai-providers/openai-main/auth/resolve",
				response: () =>
					jsonResponse({
						provider_id: "openai-main",
						auth_type: "api_key",
						value: "sk-managed-secret",
						profile: "default",
					}),
			},
			{
				method: "GET",
				path: "/v1/models",
				response: () => jsonResponse({ data: [] }),
			},
		]);
		const { output, restore } = captureConsole();
		try {
			await aiProviderImportCommand(catalogPath, { json: true });
			await aiProviderTestCommand("openai-main", { live: true, json: true });
		} finally {
			restore();
			restoreFetch();
		}

		expect(captured[0].body).toEqual({ profile: "default" });
		const providerProbe = captured.find((request) => request.path === "/v1/models");
		expect(providerProbe?.headers.authorization).toBe("Bearer sk-managed-secret");
		expect(output()).toContain('"status": "ok"');
		expect(output()).not.toContain("sk-managed-secret");
	});

	it("uses managed provider runtime env before resolving through the backend", async () => {
		const catalogPath = join(tmpHome, "providers.json");
		writeFileSync(
			catalogPath,
			JSON.stringify({
				schema_version: 1,
				providers: [
					{
						id: "clawdi-managed",
						type: "custom_openai_compatible",
						base_url: "https://sub2api.example.test/v1",
						default_model: "gpt-5.5",
						api_mode: "openai_chat",
						auth: {
							type: "api_key",
							source: "managed",
						},
						managed_by: "clawdi",
						runtime_env_name: "CLAWDI_MANAGED_OPENAI_API_KEY",
					},
				],
			}),
		);
		const oldRuntimeKey = process.env.CLAWDI_MANAGED_OPENAI_API_KEY;
		process.env.CLAWDI_MANAGED_OPENAI_API_KEY = "sk-runtime-managed";
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "GET",
				path: "/v1/models",
				response: () => jsonResponse({ data: [] }),
			},
		]);
		const { output, restore } = captureConsole();
		try {
			await aiProviderImportCommand(catalogPath, { json: true });
			await aiProviderTestCommand("clawdi-managed", { live: true, json: true });
		} finally {
			restore();
			restoreFetch();
			if (oldRuntimeKey === undefined) delete process.env.CLAWDI_MANAGED_OPENAI_API_KEY;
			else process.env.CLAWDI_MANAGED_OPENAI_API_KEY = oldRuntimeKey;
		}

		expect(
			captured.some((request) => request.path === "/api/ai-providers/clawdi-managed/auth/resolve"),
		).toBe(false);
		const providerProbe = captured.find((request) => request.path === "/v1/models");
		expect(providerProbe?.headers.authorization).toBe("Bearer sk-runtime-managed");
		expect(output()).toContain('"status": "ok"');
		expect(output()).toContain("managed api_key:env:CLAWDI_MANAGED_OPENAI_API_KEY");
		expect(output()).not.toContain("sk-runtime-managed");
	});

	it("rejects invalid provider probe timeouts", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await expect(
				aiProviderTestCommand("openai-main", { live: true, timeout: "nope" }),
			).rejects.toThrow("--timeout must be a positive number");
		} finally {
			restore();
		}
	});

	it("materializes a provider-bound Codex auth profile", async () => {
		mkdirSync(join(tmpHome, ".codex"), { recursive: true });
		const codexAuthPath = join(tmpHome, ".codex", "auth.json");
		writeFileSync(codexAuthPath, "old-auth");
		if (process.platform !== "win32") {
			chmodSync(codexAuthPath, 0o644);
		}
		const payload = {
			schemaVersion: 1,
			kind: "local_agent_profile",
			tool: "codex",
			profile: "default",
			importedAt: new Date().toISOString(),
			files: [
				{
					logicalName: "auth.json",
					sourcePath: "/source/.codex/auth.json",
					targetStrategy: "adapter_default",
					content: "new-auth",
					mode: 0o644,
					size: 8,
				},
			],
		};
		const { restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: "/api/ai-providers/openai-codex/auth/resolve",
				response: () =>
					jsonResponse({
						provider_id: "openai-codex",
						auth_type: "agent_profile",
						payload: JSON.stringify(payload),
						profile: "default",
						tool: "codex",
					}),
			},
		]);
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "agent:codex/default",
				json: true,
			});
			await aiProviderMaterializeAuthCommand("openai-codex", { yes: true });
		} finally {
			restore();
			restoreFetch();
		}

		expect(readFileSync(codexAuthPath, "utf-8")).toBe("new-auth");
	});

	it("projects Codex auth profiles to native Hermes config without key env", () => {
		const projection = buildAgentTargetProjection("hermes", {
			schema_version: 1,
			providers: [
				{
					id: "openai-codex",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					default_model: "gpt-5.2",
					api_mode: "openai_responses",
					auth: { type: "agent_profile", tool: "codex", profile: "default" },
					runtime_env_name: "OPENAI_API_KEY",
				},
			],
		});

		const patch = projection.files[0]?.content ?? "";
		expect(patch).toContain('provider: "openai-codex"');
		expect(patch).toContain("https://chatgpt.com/backend-api/codex");
		expect(patch).not.toContain("key_env");
		expect(patch).not.toContain("OPENAI_API_KEY");
	});

	it("applies Hermes Codex OAuth through the native provider selector", async () => {
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const hermesConfig = join(hermesDir, "config.yaml");
		writeFileSync(
			hermesConfig,
			[
				"model:",
				"  provider: custom:old",
				"  base_url: https://stale.example/v1",
				"  api_key: sk-stale",
				"providers:",
				"  local-legacy:",
				"    keep_me: true",
				"",
			].join("\n"),
		);
		const { restore: restoreFetch } = mockFetch([codexAuthResolveHandler()]);
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "agent:codex/default",
				json: true,
			});
			await aiProviderApplyCommand({ target: "hermes", json: true });
		} finally {
			restore();
			restoreFetch();
		}

		const parsed = parseYaml(readFileSync(hermesConfig, "utf-8"));
		expect(parsed.model).toMatchObject({
			provider: "openai-codex",
			default: "gpt-5.2",
			base_url: "https://chatgpt.com/backend-api/codex",
		});
		expect(parsed.model.api_key).toBeUndefined();
		expect(parsed.providers["local-legacy"]).toMatchObject({ keep_me: true });
		const authStore = JSON.parse(readFileSync(join(hermesDir, "auth.json"), "utf-8"));
		expect(authStore.providers["openai-codex"].tokens.access_token).toBe(FAKE_CODEX_ACCESS_TOKEN);
		expect(authStore.credential_pool["openai-codex"][0]).toMatchObject({
			source: "device_code",
			auth_type: "oauth",
			access_token: FAKE_CODEX_ACCESS_TOKEN,
			refresh_token: FAKE_CODEX_REFRESH_TOKEN,
			base_url: "https://chatgpt.com/backend-api/codex",
		});
	});

	it("applies one Codex OAuth source to all matching targets by default", async () => {
		const codexHome = join(tmpHome, ".codex");
		process.env.CODEX_HOME = codexHome;
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const stubDir = join(tmpHome, "bin");
		const openClawArgs = join(tmpHome, "openclaw-args");
		const openClawStdin = join(tmpHome, "openclaw-stdin.json");
		mkdirSync(stubDir, { recursive: true });
		writeFileSync(
			join(stubDir, "openclaw"),
			`#!/bin/sh\nprintf "%s\\n" "$@" > "${openClawArgs}"\ncat > "${openClawStdin}"\nexit 0\n`,
		);
		chmodSync(join(stubDir, "openclaw"), 0o755);
		process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;
		const { captured, restore: restoreFetch } = mockFetch([codexAuthResolveHandler()]);
		const setup = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "agent:codex/default",
				json: true,
			});
			await aiProviderAddCommand("anthropic-main", {
				type: "anthropic",
				defaultModel: "claude-opus-4-6",
				auth: "env:ANTHROPIC_API_KEY",
				json: true,
			});
		} finally {
			setup.restore();
		}
		const { output, restore } = captureConsole();
		try {
			await aiProviderApplyCommand({ source: "openai-codex", json: true });
		} finally {
			restore();
			restoreFetch();
		}

		expect(output()).toContain('"source": "openai-codex"');
		expect(output()).toContain('"target": "codex"');
		expect(output()).toContain('"target": "hermes"');
		expect(output()).toContain('"target": "openclaw"');
		expect(output()).toContain('"secret_writes"');
		expect(output()).toContain("Hermes openai-codex auth store");
		expect(output()).toContain("OpenClaw OpenAI auth profile");
		expect(output()).not.toContain(FAKE_CODEX_ACCESS_TOKEN);
		expect(output()).not.toContain(FAKE_CODEX_REFRESH_TOKEN);
		expect(output()).not.toContain("anthropic-main");
		expect(
			captured.filter((request) => request.path === "/api/ai-providers/openai-codex/auth/resolve"),
		).toHaveLength(3);
		const codexProfile = readFileSync(join(codexHome, "clawdi-ai-provider.config.toml"), "utf-8");
		expect(codexProfile).toContain('model_provider = "openai"');
		const codexAuth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf-8"));
		expect(codexAuth.tokens.access_token).toBe(FAKE_CODEX_ACCESS_TOKEN);
		const hermesConfig = parseYaml(readFileSync(join(hermesDir, "config.yaml"), "utf-8"));
		expect(hermesConfig.model.provider).toBe("openai-codex");
		const hermesAuth = JSON.parse(readFileSync(join(hermesDir, "auth.json"), "utf-8"));
		expect(hermesAuth.active_provider).toBe("openai-codex");
		expect(hermesAuth.providers["openai-codex"].tokens.refresh_token).toBe(
			FAKE_CODEX_REFRESH_TOKEN,
		);
		const openClawPatch = JSON.parse(readFileSync(openClawStdin, "utf-8"));
		expect(readFileSync(openClawArgs, "utf-8").trim().split("\n")).toEqual([
			"config",
			"patch",
			"--stdin",
		]);
		expect(openClawPatch.plugins.entries.codex.enabled).toBe(true);
		expect(openClawPatch.agents.defaults.model.primary).toBe("openai/gpt-5.2");
		expect(openClawPatch.models).toBeUndefined();
		const openClawAuth = JSON.parse(
			readFileSync(
				join(tmpHome, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
				"utf-8",
			),
		);
		expect(openClawAuth.profiles["openai:default"]).toMatchObject({
			type: "oauth",
			provider: "openai",
			access: FAKE_CODEX_ACCESS_TOKEN,
			refresh: FAKE_CODEX_REFRESH_TOKEN,
			accountId: "acct-test",
		});
		expect(openClawAuth.order.openai[0]).toBe("openai:default");
	});

	it("dry-runs Codex apply without writing the Codex profile", async () => {
		const codexHome = join(tmpHome, ".codex");
		process.env.CODEX_HOME = codexHome;
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "codex", dryRun: true, json: true });
		} finally {
			restore();
		}

		const profilePath = join(codexHome, "clawdi-ai-provider.config.toml");
		expect(output()).toContain('"dry_run": true');
		expect(output()).toContain('"target_contract"');
		expect(output()).toContain('"provider_ids"');
		expect(output()).toContain("clawdi-ai-provider.config.toml");
		expect(output()).toContain("codex --profile clawdi-ai-provider");
		expect(existsSync(profilePath)).toBe(false);
	});

	it("applies Codex through a profile file without editing config.toml", async () => {
		const codexHome = join(tmpHome, ".codex");
		process.env.CODEX_HOME = codexHome;
		mkdirSync(codexHome, { recursive: true });
		const userConfig = join(codexHome, "config.toml");
		const originalConfig = 'model = "user-model"\n';
		writeFileSync(userConfig, originalConfig);
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "codex", json: true });
		} finally {
			restore();
		}

		const profilePath = join(codexHome, "clawdi-ai-provider.config.toml");
		expect(readFileSync(userConfig, "utf-8")).toBe(originalConfig);
		expect(readFileSync(profilePath, "utf-8")).toContain('model_provider = "openai-main"');
		expect(readFileSync(profilePath, "utf-8")).toContain('[model_providers."openai-main"]');
		expect(readFileSync(profilePath, "utf-8")).toContain('wire_api = "responses"');
		expect(readFileSync(profilePath, "utf-8")).toContain('env_key = "OPENAI_API_KEY"');
		expect(readFileSync(profilePath, "utf-8")).toContain("@openai/codex 0.134.0 through 0.137.0");
		expect(output()).toContain("clawdi-ai-provider.config.toml");
		expect(output()).toContain('"dry_run": false');
		expect(output()).toContain("codex --profile clawdi-ai-provider");
		expect(existsSync(join(tmpHome, ".clawdi", "runtime", "codex"))).toBe(false);
		if (process.platform !== "win32") {
			expect(statSync(profilePath).mode & 0o777).toBe(0o600);
		}
	});

	it("applies Codex with multiple compatible providers in one profile", async () => {
		const codexHome = join(tmpHome, ".codex");
		process.env.CODEX_HOME = codexHome;
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderAddCommand("gateway-main", {
				type: "custom_openai_compatible",
				baseUrl: "https://gateway.example/v1",
				defaultModel: "gpt-5.2",
				apiMode: "openai_responses",
				auth: "env:GATEWAY_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "codex", json: true });
		} finally {
			restore();
		}

		const profile = readFileSync(join(codexHome, "clawdi-ai-provider.config.toml"), "utf-8");
		expect(profile).toContain('model_provider = "openai-main"');
		expect(profile).toContain('[model_providers."openai-main"]');
		expect(profile).toContain('env_key = "OPENAI_API_KEY"');
		expect(profile).toContain('[model_providers."gateway-main"]');
		expect(profile).toContain('base_url = "https://gateway.example/v1"');
		expect(profile).toContain('env_key = "GATEWAY_API_KEY"');
	});

	it("inspects Codex apply state from the native profile path", async () => {
		const codexHome = join(tmpHome, ".codex");
		process.env.CODEX_HOME = codexHome;
		const add = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
		} finally {
			add.restore();
		}

		const before = captureConsole();
		try {
			await aiProviderStatusCommand({ json: true });
		} finally {
			before.restore();
		}
		expect(before.output()).toContain('"target": "codex"');
		expect(before.output()).toContain('"agent_env_name": "OPENAI_API_KEY"');
		expect(before.output()).toContain('"target_contract"');
		expect(before.output()).toContain('"applied": false');
		expect(before.output()).toContain("clawdi-ai-provider.config.toml");

		const apply = captureConsole();
		try {
			await aiProviderApplyCommand({ target: "codex", json: true });
		} finally {
			apply.restore();
		}

		const after = captureConsole();
		try {
			await aiProviderStatusCommand({ json: true });
		} finally {
			after.restore();
		}
		expect(after.output()).toContain('"target": "codex"');
		expect(after.output()).toContain('"applied": true');
	});

	it("clears stale runtime env names when auth changes to an env ref", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "clawdi://default/openai/api_key",
				agentEnv: "OLD_OPENAI_API_KEY",
				json: true,
			});
			await aiProviderEditCommand("openai-main", {
				auth: "env:NEW_OPENAI_API_KEY",
				json: true,
			});
		} finally {
			restore();
		}

		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.providers[0].runtime_env_name).toBeUndefined();

		const status = captureConsole();
		try {
			await aiProviderStatusCommand({ json: true });
		} finally {
			status.restore();
		}
		expect(status.output()).toContain('"agent_env_name": "NEW_OPENAI_API_KEY"');
		expect(status.output()).not.toContain("OLD_OPENAI_API_KEY");
	});

	it("uses Codex native auth for Codex agent profiles", async () => {
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "agent:codex/default",
				json: true,
			});
			await aiProviderApplyCommand({ target: "codex", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(output()).toContain('model_provider = \\"openai\\"');
		expect(output()).toContain('model = \\"gpt-5.2\\"');
		expect(output()).not.toContain("env_key");
		expect(output()).not.toContain("[model_providers");
	});

	it("applies a Codex auth source to the Codex profile and auth store", async () => {
		const codexHome = join(tmpHome, ".codex");
		process.env.CODEX_HOME = codexHome;
		const { restore: restoreFetch } = mockFetch([codexAuthResolveHandler()]);
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "agent:codex/default",
				json: true,
			});
			await aiProviderApplyCommand({ source: "openai-codex", target: "codex", json: true });
		} finally {
			restore();
			restoreFetch();
		}

		const profile = readFileSync(join(codexHome, "clawdi-ai-provider.config.toml"), "utf-8");
		expect(profile).toContain('model_provider = "openai"');
		const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf-8"));
		expect(auth.tokens.access_token).toBe(FAKE_CODEX_ACCESS_TOKEN);
		expect(auth.tokens.refresh_token).toBe(FAKE_CODEX_REFRESH_TOKEN);
		expect(output()).toContain("Codex auth.json from agent:codex profile");
		expect(output()).not.toContain(FAKE_CODEX_ACCESS_TOKEN);
		expect(output()).not.toContain(FAKE_CODEX_REFRESH_TOKEN);
	});

	it("rejects Codex apply for chat-only providers", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openrouter-main", {
				type: "openrouter",
				defaultModel: "openai/gpt-5.2",
				auth: "env:OPENROUTER_API_KEY",
				json: true,
			});
			await expect(
				aiProviderApplyCommand({ target: "codex", dryRun: true, json: true }),
			).rejects.toThrow("Responses-compatible providers only");
		} finally {
			restore();
		}
	});

	it("lets Codex apply skip incompatible providers while keeping a usable default", async () => {
		const codexHome = join(tmpHome, ".codex");
		process.env.CODEX_HOME = codexHome;
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("anthropic-main", {
				type: "anthropic",
				defaultModel: "claude-opus-4-6",
				auth: "env:ANTHROPIC_API_KEY",
				setDefault: true,
				json: true,
			});
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "agent:codex/default",
				json: true,
			});
			await aiProviderApplyCommand({ target: "codex", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(output()).toContain("Provider anthropic-main skipped for codex");
		expect(output()).toContain("Default provider anthropic-main cannot be applied to codex");
		expect(output()).toContain('model = \\"gpt-5.2\\"');
		expect(output()).toContain('model_provider = \\"openai\\"');
	});

	it("dry-runs Hermes apply without mutating config.yaml or printing existing inline secrets", async () => {
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const hermesConfig = join(hermesDir, "config.yaml");
		const originalConfig =
			'mcp_servers:\n  clawdi:\n    command: "clawdi"\nproviders:\n  old:\n    api_key: sk-existing-secret\n';
		writeFileSync(hermesConfig, originalConfig);
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "hermes", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(readFileSync(hermesConfig, "utf-8")).toBe(originalConfig);
		expect(output()).toContain('"dry_run": true');
		expect(output()).toContain("Hermes config.yaml provider merge");
		expect(output()).toContain("custom:openai-main");
		expect(output()).toContain("OPENAI_API_KEY");
		expect(output()).not.toContain("sk-existing-secret");
		expect(existsSync(join(tmpHome, ".clawdi", "runtime", "hermes"))).toBe(false);
	});

	it("dry-runs Hermes apply without calling hermes", async () => {
		const binDir = join(tmpHome, "bin");
		mkdirSync(binDir, { recursive: true });
		const logPath = join(tmpHome, "hermes-calls.log");
		const hermesPath = join(binDir, "hermes");
		writeFileSync(hermesPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexit 0\n`, {
			mode: 0o755,
		});
		chmodSync(hermesPath, 0o755);
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "hermes", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(output()).toContain('"dry_run": true');
		expect(output()).toContain("Hermes config.yaml provider merge");
		expect(output()).toContain("https://api.openai.com/v1");
		expect(existsSync(logPath)).toBe(false);
	});

	it("applies Hermes through a structured config.yaml merge", async () => {
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const hermesConfig = join(hermesDir, "config.yaml");
		const originalConfig = [
			"# user hermes config",
			"mcp_servers:",
			"  clawdi:",
			"    command: clawdi # keep setup comment",
			"model:",
			"  provider: custom",
			"  base_url: https://stale.example/v1",
			"  api_key: sk-stale-model",
			"providers:",
			"  openai-main:",
			"    base_url: https://stale.example/v1",
			"    api_key: sk-stale-provider",
			"    extra_body:",
			"      keep: true",
			"",
		].join("\n");
		writeFileSync(hermesConfig, originalConfig);
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "hermes", json: true });
		} finally {
			restore();
		}

		const mergedConfig = readFileSync(hermesConfig, "utf-8");
		expect(mergedConfig).toContain("# user hermes config");
		expect(mergedConfig).toContain("mcp_servers:");
		expect(mergedConfig).toContain("command: clawdi # keep setup comment");
		expect(mergedConfig).toContain("provider: custom:openai-main");
		expect(mergedConfig).toContain("default: gpt-5.2");
		expect(mergedConfig).toContain("openai-main:");
		expect(mergedConfig).toContain("api: https://api.openai.com/v1");
		expect(mergedConfig).toContain("transport: codex_responses");
		expect(mergedConfig).toContain("default_model: gpt-5.2");
		expect(mergedConfig).toContain("key_env: OPENAI_API_KEY");
		expect(mergedConfig).toContain("extra_body:");
		expect(mergedConfig).toContain("keep: true");
		expect(mergedConfig).not.toContain("sk-stale-model");
		expect(mergedConfig).not.toContain("sk-stale-provider");
	});

	it("applies Hermes with multiple providers while preserving unrelated provider config", async () => {
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const hermesConfig = join(hermesDir, "config.yaml");
		writeFileSync(
			hermesConfig,
			[
				"providers:",
				"  local-legacy:",
				"    api: http://127.0.0.1:11434/v1",
				"    transport: chat_completions",
				"    keep_me: true",
				"",
			].join("\n"),
		);
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderAddCommand("anthropic-main", {
				type: "anthropic",
				defaultModel: "claude-opus-4-6",
				auth: "env:ANTHROPIC_API_KEY",
				setDefault: true,
				json: true,
			});
			await aiProviderApplyCommand({ target: "hermes", json: true });
		} finally {
			restore();
		}

		const parsed = parseYaml(readFileSync(hermesConfig, "utf-8"));
		expect(parsed.model.provider).toBe("custom:anthropic-main");
		expect(parsed.model.default).toBe("claude-opus-4-6");
		expect(parsed.providers["openai-main"]).toMatchObject({
			api: "https://api.openai.com/v1",
			transport: "codex_responses",
			default_model: "gpt-5.2",
			key_env: "OPENAI_API_KEY",
		});
		expect(parsed.providers["anthropic-main"]).toMatchObject({
			api: "https://api.anthropic.com",
			transport: "anthropic_messages",
			default_model: "claude-opus-4-6",
			key_env: "ANTHROPIC_API_KEY",
		});
		expect(parsed.providers["local-legacy"]).toMatchObject({
			api: "http://127.0.0.1:11434/v1",
			transport: "chat_completions",
			keep_me: true,
		});
	});

	it("lets Hermes apply Codex OAuth with compatible provider entries", async () => {
		const binDir = join(tmpHome, "bin");
		mkdirSync(binDir, { recursive: true });
		const hermesPath = join(binDir, "hermes");
		writeFileSync(hermesPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(hermesPath, 0o755);
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "agent:codex/default",
				json: true,
			});
			await aiProviderAddCommand("anthropic-main", {
				type: "anthropic",
				defaultModel: "claude-opus-4-6",
				auth: "env:ANTHROPIC_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "hermes", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(output()).toContain('provider: \\"openai-codex\\"');
		expect(output()).toContain("https://chatgpt.com/backend-api/codex");
		expect(output()).toContain("anthropic-main");
		expect(output()).toContain("ANTHROPIC_API_KEY");
		expect(output()).toContain("Hermes openai-codex auth store");
		expect(output()).not.toContain("Provider openai-codex skipped for hermes");
		expect(output()).not.toContain("openai-codex:");
	});

	it("upgrades a scalar Hermes model config during structured merge", async () => {
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const hermesConfig = join(hermesDir, "config.yaml");
		writeFileSync(hermesConfig, "model: old-model\nproviders:\n");
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "hermes", json: true });
		} finally {
			restore();
		}

		const mergedConfig = readFileSync(hermesConfig, "utf-8");
		expect(mergedConfig).toContain("model:");
		expect(mergedConfig).toContain("provider: custom:openai-main");
		expect(mergedConfig).toContain("default: gpt-5.2");
		expect(mergedConfig).toContain("openai-main:");
	});

	it("supports dotted provider ids in Hermes config.yaml merge", async () => {
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const hermesConfig = join(hermesDir, "config.yaml");
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai.main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "hermes", json: true });
		} finally {
			restore();
		}

		expect(existsSync(join(tmpHome, ".clawdi", "runtime", "hermes"))).toBe(false);
		const mergedConfig = readFileSync(hermesConfig, "utf-8");
		expect(mergedConfig).toContain("provider: custom:openai.main");
		expect(mergedConfig).toContain("openai.main:");
	});

	it("quotes scalar-like provider ids in Hermes config.yaml merge", async () => {
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const hermesConfig = join(hermesDir, "config.yaml");
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("true", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "hermes", json: true });
		} finally {
			restore();
		}

		const mergedConfig = readFileSync(hermesConfig, "utf-8");
		expect(mergedConfig).toContain('"true":');
		const parsed = parseYaml(mergedConfig);
		expect(parsed.model.provider).toBe("custom:true");
		expect(parsed.providers.true).toMatchObject({
			api: "https://api.openai.com/v1",
			transport: "codex_responses",
		});
	});

	it("requires default_model before ai-provider apply", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await expect(
				aiProviderApplyCommand({ target: "codex", dryRun: true, json: true }),
			).rejects.toThrow("requires default_model");
		} finally {
			restore();
		}
	});

	it("dry-runs OpenClaw apply without calling openclaw", async () => {
		const { output, restore } = captureConsole();
		const stubDir = join(tmpHome, "bin");
		mkdirSync(stubDir, { recursive: true });
		writeFileSync(join(stubDir, "openclaw"), "#!/bin/sh\nexit 42\n");
		chmodSync(join(stubDir, "openclaw"), 0o755);
		process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				agentEnv: "OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "openclaw", dryRun: true, json: true });
		} finally {
			restore();
		}
		expect(output()).not.toContain("sk-ai-provider");
		expect(output()).toContain('"target": "openclaw"');
		expect(output()).toContain('"command": "openclaw"');
		expect(output()).toContain('"stdin"');
		expect(output()).toContain("apiKey");
		expect(output()).toContain("openai-main/gpt-5.2");
	});

	it("applies OpenClaw through config patch stdin", async () => {
		const stubDir = join(tmpHome, "bin");
		const argsPath = join(tmpHome, "openclaw-args");
		const stdinPath = join(tmpHome, "openclaw-stdin.json");
		mkdirSync(stubDir, { recursive: true });
		writeFileSync(
			join(stubDir, "openclaw"),
			`#!/bin/sh\nprintf "%s\\n" "$@" > "${argsPath}"\ncat > "${stdinPath}"\nexit 0\n`,
		);
		chmodSync(join(stubDir, "openclaw"), 0o755);
		process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				agentEnv: "OPENAI_API_KEY",
				json: true,
			});
			await aiProviderApplyCommand({ target: "openclaw", json: true });
		} finally {
			restore();
		}

		expect(output()).toContain('"target": "openclaw"');
		expect(readFileSync(argsPath, "utf-8").trim().split("\n")).toEqual([
			"config",
			"patch",
			"--stdin",
		]);
		const patch = JSON.parse(readFileSync(stdinPath, "utf-8"));
		expect(patch.agents.defaults.model.primary).toBe("openai-main/gpt-5.2");
		expect(patch.models.mode).toBe("merge");
		expect(patch.models.providers["openai-main"].api).toBe("openai-responses");
		expect(patch.models.providers["openai-main"].apiKey).toEqual({
			source: "env",
			provider: "default",
			id: "OPENAI_API_KEY",
		});
	});

	it("preserves existing OpenClaw provider models during apply", async () => {
		const stubDir = join(tmpHome, "bin");
		const stdinPath = join(tmpHome, "openclaw-stdin.json");
		const openclawDir = join(tmpHome, ".openclaw");
		const catalogPath = join(tmpHome, "managed-catalog.json");
		mkdirSync(stubDir, { recursive: true });
		mkdirSync(openclawDir, { recursive: true });
		writeFileSync(join(stubDir, "openclaw"), `#!/bin/sh\ncat > "${stdinPath}"\nexit 0\n`);
		chmodSync(join(stubDir, "openclaw"), 0o755);
		process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;
		writeFileSync(
			join(openclawDir, "openclaw.json"),
			JSON.stringify({
				models: {
					providers: {
						openai: {
							models: [
								{ id: "gpt-5.5", name: "GPT-5.5", contextWindow: 272000 },
								{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000 },
								{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
								{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
							],
						},
					},
				},
			}),
		);
		writeFileSync(
			catalogPath,
			JSON.stringify({
				schema_version: 1,
				providers: [
					{
						id: "custom-openai",
						type: "custom_openai_compatible",
						label: "Custom OpenAI",
						base_url: "https://sub2api.example.test/v1",
						default_model: "openai-codex/gpt-5.5",
						api_mode: "codex_responses",
						auth: { type: "api_key", source: "managed" },
						managed_by: "user",
						runtime_env_name: "CUSTOM_OPENAI_API_KEY",
					},
				],
				defaults: { chat_provider_id: "custom-openai" },
			}),
		);

		const { restore } = captureConsole();
		try {
			await aiProviderImportCommand(catalogPath, { json: true });
			await aiProviderApplyCommand({ target: "openclaw", json: true });
		} finally {
			restore();
		}

		const patch = JSON.parse(readFileSync(stdinPath, "utf-8"));
		expect(patch.models.providers.openai.models.map((model: { id: string }) => model.id)).toEqual([
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.3-codex",
			"gpt-5.4-mini",
		]);
		expect(patch.models.providers.openai.models[0]).toMatchObject({
			id: "gpt-5.5",
			name: "gpt-5.5",
			contextWindow: 272000,
		});
		expect(patch.models.providers.openai.models[1]).toMatchObject({
			id: "gpt-5.4",
			contextWindow: 272000,
		});
	});

	it("projects Clawdi-managed OpenAI chat providers directly to OpenClaw", async () => {
		const catalog = {
			schema_version: 1,
			providers: [
				{
					id: "clawdi-managed",
					type: "custom_openai_compatible",
					label: "Clawdi AI",
					base_url: "https://sub2api.example.test/v1",
					default_model: "gpt-5.5",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_MANAGED_OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "clawdi-managed" },
		} as const;

		const projection = buildAgentTargetProjection("openclaw", catalog);
		const patch = JSON.parse(projection.files[0]!.content);

		expect(patch.agents.defaults.model.primary).toBe("clawdi-managed/gpt-5.5");
		expect(patch.models.providers["clawdi-managed"].baseUrl).toBe(
			"https://sub2api.example.test/v1",
		);
		expect(patch.models.providers["clawdi-managed"].api).toBe("openai-completions");
		expect(patch.models.providers["clawdi-managed"].agentRuntime).toBeUndefined();
		expect(patch.models.providers["clawdi-managed"].models[0]).toMatchObject({
			id: "gpt-5.5",
			name: "gpt-5.5",
			api: "openai-completions",
		});
		expect(patch.models.providers["clawdi-managed"].apiKey).toEqual({
			source: "env",
			provider: "default",
			id: "CLAWDI_MANAGED_OPENAI_API_KEY",
		});
	});

	it("projects Clawdi-managed OpenAI chat providers directly to Hermes", () => {
		const projection = buildAgentTargetProjection("hermes", {
			schema_version: 1,
			providers: [
				{
					id: "clawdi-managed",
					type: "custom_openai_compatible",
					label: "Clawdi AI",
					base_url: "https://sub2api.example.test/v1",
					default_model: "gpt-5.5",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_MANAGED_OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "clawdi-managed" },
		});

		const patch = projection.files[0]?.content ?? "";
		expect(patch).toContain('provider: "custom:clawdi-managed"');
		expect(patch).toContain('api: "https://sub2api.example.test/v1"');
		expect(patch).toContain('transport: "chat_completions"');
		expect(patch).toContain('default_model: "gpt-5.5"');
		expect(patch).toContain('key_env: "CLAWDI_MANAGED_OPENAI_API_KEY"');
		expect(patch).not.toContain("chatgpt.com");
		expect(patch).not.toContain("CLAWDI_PROVIDER_PLACEHOLDER_TOKEN");
	});

	it("projects user BYOK Codex Responses providers to the OpenClaw PI route", async () => {
		const catalog = {
			schema_version: 1,
			providers: [
				{
					id: "custom-openai",
					type: "custom_openai_compatible",
					label: "My AI key",
					base_url: "https://sub2api.example.test/v1",
					default_model: "openai-codex/gpt-5.5",
					api_mode: "codex_responses",
					auth: { type: "api_key", source: "managed" },
					managed_by: "user",
					runtime_env_name: "CLAWDI_OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "custom-openai" },
		} as const;

		const projection = buildAgentTargetProjection("openclaw", catalog);
		const patch = JSON.parse(projection.files[0]!.content);

		expect(patch.agents.defaults.model.primary).toBe("openai/gpt-5.5");
		expect(Object.keys(patch.models.providers)).toEqual(["openai"]);
		expect(patch.models.providers.openai).toMatchObject({
			baseUrl: "https://sub2api.example.test/backend-api",
			api: "openai-chatgpt-responses",
			apiKey: {
				source: "env",
				provider: "default",
				id: "CLAWDI_OPENAI_API_KEY",
			},
		});
		expect(patch.models.providers.openai.models[0]).toMatchObject({
			id: "gpt-5.5",
			name: "gpt-5.5",
			api: "openai-chatgpt-responses",
			agentRuntime: { id: "pi" },
		});
	});

	it("wraps OpenClaw apply failures without echoing generated stdin", async () => {
		const stubDir = join(tmpHome, "bin");
		mkdirSync(stubDir, { recursive: true });
		writeFileSync(join(stubDir, "openclaw"), "#!/bin/sh\necho native-failed >&2\nexit 42\n");
		chmodSync(join(stubDir, "openclaw"), 0o755);
		process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				agentEnv: "OPENAI_API_KEY",
				json: true,
			});
			await expect(aiProviderApplyCommand({ target: "openclaw", json: true })).rejects.toThrow(
				"Failed to run openclaw config patch --stdin (exit 42)",
			);
		} finally {
			restore();
		}

		expect(output()).not.toContain('"models"');
		expect(output()).not.toContain("native-failed");
	});

	it("keeps the OpenClaw default model registered when catalog models omit it", () => {
		const projection = buildAgentTargetProjection("openclaw", {
			schema_version: 1,
			defaults: { chat_provider_id: "openai-main" },
			providers: [
				{
					id: "openai-main",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					default_model: "gpt-5.2",
					api_mode: "openai_responses",
					auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
					models: [{ id: "gpt-4o", label: "GPT 4o", input_modalities: ["text", "image"] }],
				},
			],
		});

		const patch = JSON.parse(projection.files[0]?.content ?? "{}");
		expect(
			patch.models.providers["openai-main"].models.map((model: { id: string }) => model.id),
		).toEqual(["gpt-5.2", "gpt-4o"]);
		expect(patch.models.providers["openai-main"].models[1].input).toEqual(["text", "image"]);
	});

	it("projects multiple OpenClaw providers with merge mode and one default", () => {
		const projection = buildAgentTargetProjection("openclaw", {
			schema_version: 1,
			defaults: { chat_provider_id: "anthropic-main" },
			providers: [
				{
					id: "openai-main",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					default_model: "gpt-5.2",
					api_mode: "openai_responses",
					auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
				},
				{
					id: "anthropic-main",
					type: "anthropic",
					base_url: "https://api.anthropic.com",
					default_model: "claude-opus-4-6",
					api_mode: "anthropic_messages",
					auth: { type: "secret_ref", ref: "env:ANTHROPIC_API_KEY" },
				},
			],
		});

		const patch = JSON.parse(projection.files[0]?.content ?? "{}");
		expect(patch.models.mode).toBe("merge");
		expect(patch.agents.defaults.model.primary).toBe("anthropic-main/claude-opus-4-6");
		expect(Object.keys(patch.models.providers)).toEqual(["openai-main", "anthropic-main"]);
		expect(patch.models.providers["openai-main"].api).toBe("openai-responses");
		expect(patch.models.providers["anthropic-main"].api).toBe("anthropic-messages");
		expect(patch.models.providers["openai-main"].apiKey.id).toBe("OPENAI_API_KEY");
		expect(patch.models.providers["anthropic-main"].apiKey.id).toBe("ANTHROPIC_API_KEY");
	});

	it("projects Codex OAuth to OpenClaw native OpenAI route without apiKey", () => {
		const projection = buildAgentTargetProjection("openclaw", {
			schema_version: 1,
			defaults: { chat_provider_id: "openai-codex" },
			providers: [
				{
					id: "openai-codex",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					default_model: "gpt-5.2",
					api_mode: "openai_responses",
					auth: { type: "agent_profile", tool: "codex", profile: "default" },
				},
			],
		});

		const patch = JSON.parse(projection.files[0]?.content ?? "{}");
		expect(patch.plugins.entries.codex.enabled).toBe(true);
		expect(patch.agents.defaults.model.primary).toBe("openai/gpt-5.2");
		expect(patch.models).toBeUndefined();
		expect(JSON.stringify(patch)).not.toContain("apiKey");
		expect(projection.warnings).toEqual([]);
	});

	it("imports provider metadata from a Hermes config without secrets", async () => {
		const hermesConfig = join(tmpHome, "hermes-config.yaml");
		writeFileSync(
			hermesConfig,
			[
				"model:",
				'  provider: "custom:openai-main"',
				"providers:",
				"  openai-main:",
				'    api: "https://api.openai.com/v1"',
				'    transport: "codex_responses"',
				'    default_model: "gpt-5.2"',
				'    key_env: "OPENAI_API_KEY"',
				"custom_providers:",
				'  - name: "OpenRouter: main"',
				'    base_url: "https://openrouter.ai/api/v1"',
				'    model: "openai/gpt-5.2"',
				'    key_env: "OPENROUTER_API_KEY"',
				"",
			].join("\n"),
		);
		const { restore } = captureConsole();
		try {
			await aiProviderImportCommand(undefined, { fromHermes: hermesConfig, json: true });
		} finally {
			restore();
		}

		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.defaults.chat_provider_id).toBe("openai-main");
		const openai = catalog.providers.find(
			(provider: { id: string }) => provider.id === "openai-main",
		);
		const openrouter = catalog.providers.find(
			(provider: { id: string }) => provider.id === "openrouter-main",
		);
		expect(openai.auth).toEqual({
			type: "secret_ref",
			ref: "env:OPENAI_API_KEY",
		});
		expect(openrouter.label).toBe("OpenRouter: main");
		expect(openrouter.auth).toEqual({
			type: "secret_ref",
			ref: "env:OPENROUTER_API_KEY",
		});
	});

	it("imports user Hermes providers using Responses transport", async () => {
		const hermesConfig = join(tmpHome, "responses-hermes-config.yaml");
		writeFileSync(
			hermesConfig,
			[
				"model:",
				'  provider: "custom:custom-openai"',
				"providers:",
				"  custom-openai:",
				'    name: "Custom OpenAI"',
				'    api: "https://sub2api.example.test/v1"',
				'    transport: "codex_responses"',
				'    default_model: "gpt-5.5"',
				'    key_env: "CUSTOM_OPENAI_API_KEY"',
				"",
			].join("\n"),
		);
		const { restore } = captureConsole();
		try {
			await aiProviderImportCommand(undefined, { fromHermes: hermesConfig, json: true });
		} finally {
			restore();
		}

		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.providers[0]).toMatchObject({
			id: "custom-openai",
			type: "openai",
			default_model: "gpt-5.5",
			api_mode: "openai_responses",
			auth: { type: "secret_ref", ref: "env:CUSTOM_OPENAI_API_KEY" },
		});
	});

	it("imports provider metadata from the current OpenClaw patch shape", async () => {
		const openclawConfig = join(tmpHome, "openclaw-config.json");
		const projection = buildAgentTargetProjection("openclaw", {
			schema_version: 1,
			defaults: { chat_provider_id: "anthropic-main" },
			providers: [
				{
					id: "openai-main",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					default_model: "gpt-5.2",
					api_mode: "openai_responses",
					auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
				},
				{
					id: "anthropic-main",
					type: "anthropic",
					base_url: "https://api.anthropic.com",
					default_model: "claude-opus-4-6",
					api_mode: "anthropic_messages",
					auth: { type: "secret_ref", ref: "env:ANTHROPIC_API_KEY" },
				},
			],
		});
		writeFileSync(openclawConfig, projection.files[0]?.content ?? "{}");
		const { restore } = captureConsole();
		try {
			await aiProviderImportCommand(undefined, { fromOpenclaw: openclawConfig, json: true });
		} finally {
			restore();
		}

		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.defaults.chat_provider_id).toBe("anthropic-main");
		expect(catalog.providers).toHaveLength(2);
		expect(catalog.providers[0]).toMatchObject({
			id: "openai-main",
			type: "openai",
			base_url: "https://api.openai.com/v1",
			default_model: "gpt-5.2",
			api_mode: "openai_responses",
			auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
			runtime_env_name: "OPENAI_API_KEY",
		});
		expect(catalog.providers[1]).toMatchObject({
			id: "anthropic-main",
			type: "anthropic",
			base_url: "https://api.anthropic.com",
			default_model: "claude-opus-4-6",
			api_mode: "anthropic_messages",
			auth: { type: "secret_ref", ref: "env:ANTHROPIC_API_KEY" },
			runtime_env_name: "ANTHROPIC_API_KEY",
		});
	});

	it("imports provider catalog envelopes from hosted materialization payloads", async () => {
		const catalogPath = join(tmpHome, "provider-envelope.json");
		writeFileSync(
			catalogPath,
			JSON.stringify(
				{
					ai_provider_catalog: {
						schema_version: 1,
						defaults: { chat_provider_id: "openai-main" },
						providers: [
							{
								id: "openai-main",
								type: "openai",
								base_url: "https://api.openai.com/v1",
								default_model: "gpt-5.2",
								auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
							},
						],
					},
				},
				null,
				2,
			),
		);
		const { restore } = captureConsole();
		try {
			await aiProviderImportCommand(catalogPath, { json: true });
		} finally {
			restore();
		}

		const catalog = JSON.parse(readFileSync(aiProviderCatalogPath(), "utf-8"));
		expect(catalog.defaults.chat_provider_id).toBe("openai-main");
		expect(catalog.providers).toHaveLength(1);
		expect(catalog.providers[0].auth).toEqual({
			type: "secret_ref",
			ref: "env:OPENAI_API_KEY",
		});
	});

	it("exports and imports env secrets only through an encrypted export bundle", async () => {
		process.env.OPENAI_API_KEY = "sk-provider-secret";
		process.env.CLAWDI_SECRET_EXPORT_PASSPHRASE = "correct horse battery staple";
		const exportPath = join(tmpHome, "providers-with-secrets.json");
		const envPath = join(tmpHome, "providers.env");
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderExportCommand({
				out: exportPath,
				includeSecrets: true,
				secretPassphrase: true,
			});
			writeFileSync(envPath, "OLD=value\n", { mode: 0o644 });
			chmodSync(envPath, 0o644);
			await aiProviderImportCommand(exportPath, {
				replace: true,
				importSecrets: "env-file",
				out: envPath,
				json: true,
			});
		} finally {
			restore();
			delete process.env.OPENAI_API_KEY;
			delete process.env.CLAWDI_SECRET_EXPORT_PASSPHRASE;
		}

		const exportJson = readFileSync(exportPath, "utf-8");
		expect(exportJson).toContain("encrypted_secrets");
		expect(exportJson).not.toContain("sk-provider-secret");
		expect(output()).not.toContain("sk-provider-secret");
		expect(readFileSync(envPath, "utf-8")).toBe("OPENAI_API_KEY='sk-provider-secret'\n");
		expect(statSync(envPath).mode & 0o777).toBe(0o600);
	});

	it("does not import encrypted secrets when catalog import conflicts", async () => {
		process.env.OPENAI_API_KEY = "sk-provider-secret";
		process.env.CLAWDI_SECRET_EXPORT_PASSPHRASE = "correct horse battery staple";
		const exportPath = join(tmpHome, "providers-with-secrets.json");
		const envPath = join(tmpHome, "providers.env");
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderExportCommand({
				out: exportPath,
				includeSecrets: true,
				secretPassphrase: true,
			});
			await expect(
				aiProviderImportCommand(exportPath, {
					importSecrets: "env-file",
					out: envPath,
					json: true,
				}),
			).rejects.toThrow("already exists");
		} finally {
			restore();
			delete process.env.OPENAI_API_KEY;
			delete process.env.CLAWDI_SECRET_EXPORT_PASSPHRASE;
		}

		expect(existsSync(envPath)).toBe(false);
	});

	it("does not import catalog metadata when encrypted secret decrypt fails", async () => {
		process.env.OPENAI_API_KEY = "sk-provider-secret";
		process.env.CLAWDI_SECRET_EXPORT_PASSPHRASE = "correct horse battery staple";
		const exportPath = join(tmpHome, "providers-with-secrets.json");
		const envPath = join(tmpHome, "providers.env");
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await aiProviderExportCommand({
				out: exportPath,
				includeSecrets: true,
				secretPassphrase: true,
			});
			rmSync(aiProviderCatalogPath(), { force: true });
			process.env.CLAWDI_SECRET_EXPORT_PASSPHRASE = "wrong passphrase";
			await expect(
				aiProviderImportCommand(exportPath, {
					importSecrets: "env-file",
					out: envPath,
					json: true,
				}),
			).rejects.toThrow();
		} finally {
			restore();
			delete process.env.OPENAI_API_KEY;
			delete process.env.CLAWDI_SECRET_EXPORT_PASSPHRASE;
		}

		expect(existsSync(aiProviderCatalogPath())).toBe(false);
		expect(existsSync(envPath)).toBe(false);
	});

	it("refuses secret export without explicit passphrase encryption", async () => {
		await expect(
			aiProviderExportCommand({ includeSecrets: true, out: "providers-with-secrets.json" }),
		).rejects.toThrow("--secret-passphrase");
	});

	it("requires an export file when importing encrypted secrets", async () => {
		const hermesConfig = join(tmpHome, "hermes-config.yaml");
		writeFileSync(
			hermesConfig,
			[
				"providers:",
				"  openai-main:",
				'    type: "openai"',
				'    base_url: "https://api.openai.com/v1"',
				'    model: "gpt-5.2"',
				'    key_env: "OPENAI_API_KEY"',
				"",
			].join("\n"),
		);

		await expect(
			aiProviderImportCommand(undefined, {
				fromHermes: hermesConfig,
				importSecrets: "env-file",
				out: join(tmpHome, "providers.env"),
				json: true,
			}),
		).rejects.toThrow("--import-secrets requires an AI Provider export file");
	});
});

function captureConsole(): { output: () => string; restore: () => void } {
	const origLog = console.log;
	const origWrite = process.stdout.write;
	let out = "";
	console.log = (...args: unknown[]) => {
		out += `${args.map(String).join(" ")}\n`;
	};
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out += chunk.toString();
		return true;
	}) as typeof process.stdout.write;
	return {
		output: () => out,
		restore: () => {
			console.log = origLog;
			process.stdout.write = origWrite;
		},
	};
}

const FAKE_CODEX_ACCESS_TOKEN = "codex-access-secret";
const FAKE_CODEX_REFRESH_TOKEN = "codex-refresh-secret";
const FAKE_CODEX_ID_TOKEN = "codex-id-secret";

function codexAuthResolveHandler() {
	return {
		method: "POST",
		path: "/api/ai-providers/openai-codex/auth/resolve",
		response: () =>
			jsonResponse({
				provider_id: "openai-codex",
				auth_type: "agent_profile",
				payload: codexAuthEnvelope(),
				profile: "default",
				tool: "codex",
			}),
	};
}

function codexAuthEnvelope(): string {
	const content = JSON.stringify(
		{
			tokens: {
				access_token: FAKE_CODEX_ACCESS_TOKEN,
				refresh_token: FAKE_CODEX_REFRESH_TOKEN,
				id_token: FAKE_CODEX_ID_TOKEN,
				account_id: "acct-test",
			},
			last_refresh: "2026-06-04T00:00:00Z",
		},
		null,
		2,
	);
	return JSON.stringify({
		schemaVersion: 1,
		kind: "local_agent_profile",
		tool: "codex",
		profile: "default",
		importedAt: "2026-06-04T00:00:00Z",
		files: [
			{
				logicalName: "auth.json",
				sourcePath: "/source/.codex/auth.json",
				targetStrategy: "adapter_default",
				content,
				mode: 0o600,
				size: content.length,
			},
		],
	});
}

async function waitForStartRedirectUri(
	captured: Array<{ path: string; body?: unknown }>,
): Promise<string> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const request = captured.find(
			(item) => item.path === "/api/ai-providers/openai-codex/auth/oauth/start",
		);
		const body = request?.body;
		if (isRecord(body) && typeof body.redirect_uri === "string") return body.redirect_uri;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for OAuth start redirect_uri.");
}

async function requestLocalCallback(url: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const req = httpGet(url, (res) => {
			res.resume();
			res.on("end", resolve);
		});
		req.on("error", reject);
	});
}

async function occupyLoopbackPort(port: number): Promise<ReturnType<typeof createServer> | null> {
	const server = createServer((_req, res) => {
		res.writeHead(404);
		res.end();
	});
	return await new Promise((resolve) => {
		server.once("error", () => resolve(null));
		server.listen(port, () => resolve(server));
	});
}

async function closeServer(server: ReturnType<typeof createServer> | null): Promise<void> {
	if (!server) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}
