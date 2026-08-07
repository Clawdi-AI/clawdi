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
import {
	aiProviderAddCommand,
	aiProviderCompleteOAuthCommand,
	aiProviderConnectCommand,
	aiProviderExportCommand,
	aiProviderImportAuthCommand,
	aiProviderImportCommand,
	aiProviderListCommand,
	aiProviderRemoveCommand,
	aiProviderTestCommand,
	aiProviderValidateCommand,
} from "../../src/commands/ai-provider";
import { aiProviderCatalogPath } from "../../src/lib/ai-provider-catalog";
import { buildAgentTargetProjection } from "../../src/lib/ai-provider-projection";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-ai-provider-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "https://api.test";
	writeFileSync(
		join(tmpHome, ".clawdi", "auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			endpointBinding: { version: 1, cloudApiOrigin: "https://api.test" },
		}),
	);
	delete process.env.CLAWDI_HOME;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origClawdiHome) process.env.CLAWDI_HOME = origClawdiHome;
	else delete process.env.CLAWDI_HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
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
				path: "/v1/ai-providers/openai-codex/auth/import",
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
				path: "/v1/ai-providers",
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
		} finally {
			restore();
		}
	});

	it("starts provider OAuth through the backend link flow", async () => {
		const { captured, restore: restoreFetch } = mockFetch([
			{
				method: "POST",
				path: "/v1/ai-providers/openai-codex/auth/oauth/start",
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
				path: "/v1/ai-providers",
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
				path: "/v1/ai-providers/openai-codex/auth/oauth/start",
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
				path: "/v1/ai-providers/openai-codex/auth/oauth/complete",
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
				path: "/v1/ai-providers",
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
				path: "/v1/ai-providers/openai-codex/auth/oauth/start",
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
				path: "/v1/ai-providers/openai-codex/auth/oauth/complete",
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
				path: "/v1/ai-providers",
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
				path: "/v1/ai-providers/openai-codex/auth/oauth/complete",
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
				path: "/v1/ai-providers/openai-codex/auth/oauth/start",
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
				path: "/v1/ai-providers",
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
				(request) => request.path === "/v1/ai-providers/openai-codex/auth/oauth/complete",
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
				path: /^\/v1\/vault\/resolve/,
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
			"/v1/vault/resolve?vault_slug=default&section=openai&field=api_key",
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
				path: "/v1/ai-providers/openai-main/auth/resolve",
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
						id: "clawdi-managed-v2",
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
			await aiProviderTestCommand("clawdi-managed-v2", { live: true, json: true });
		} finally {
			restore();
			restoreFetch();
			if (oldRuntimeKey === undefined) delete process.env.CLAWDI_MANAGED_OPENAI_API_KEY;
			else process.env.CLAWDI_MANAGED_OPENAI_API_KEY = oldRuntimeKey;
		}

		expect(
			captured.some(
				(request) => request.path === "/v1/ai-providers/clawdi-managed-v2/auth/resolve",
			),
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

	it("projects Clawdi-managed OpenAI chat providers directly to OpenClaw", async () => {
		const catalog = {
			schema_version: 1,
			providers: [
				{
					id: "clawdi-managed-v2",
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
			defaults: { chat_provider_id: "clawdi-managed-v2" },
		} as const;

		const projection = buildAgentTargetProjection("openclaw", catalog);
		const patch = JSON.parse(projection.files[0]!.content);

		expect(patch.agents.defaults.model.primary).toBe("clawdi/gpt-5.5");
		expect(patch.models.providers.clawdi.baseUrl).toBe("https://sub2api.example.test/v1");
		expect(patch.models.providers.clawdi.api).toBeUndefined();
		expect(patch.models.providers.clawdi.agentRuntime).toBeUndefined();
		expect(patch.models.providers.clawdi.models[0]).toMatchObject({
			id: "gpt-5.5",
			name: "gpt-5.5",
		});
		expect(patch.models.providers.clawdi.models[0].api).toBeUndefined();
		expect(patch.models.providers.clawdi.apiKey).toEqual({
			source: "env",
			provider: "default",
			id: "CLAWDI_MANAGED_OPENAI_API_KEY",
		});
		expect(JSON.stringify(patch)).not.toContain("clawdi-managed-v2");
	});

	it("projects Clawdi-managed OpenAI chat providers directly to Hermes", () => {
		const projection = buildAgentTargetProjection("hermes", {
			schema_version: 1,
			providers: [
				{
					id: "clawdi-managed-v2",
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
			defaults: { chat_provider_id: "clawdi-managed-v2" },
		});

		const patch = projection.files[0]?.content ?? "";
		expect(patch).toContain('provider: "custom:clawdi"');
		expect(patch).toContain('api: "https://sub2api.example.test/v1"');
		expect(patch).toContain('transport: "chat_completions"');
		expect(patch).toContain('key_env: "CLAWDI_MANAGED_OPENAI_API_KEY"');
		expect(patch).not.toContain("chatgpt.com");
		expect(patch).not.toContain("CLAWDI_PROVIDER_PLACEHOLDER_TOKEN");
		expect(patch).not.toContain("clawdi-managed-v2");
	});

	it("uses agent primary_model with provider catalogs that have no default_model", () => {
		const catalog = {
			schema_version: 1,
			providers: [
				{
					id: "openai-main",
					type: "custom_openai_compatible",
					base_url: "https://main.example.test/v1",
					api_mode: "openai_responses",
					auth: { type: "secret_ref", ref: "env:OPENAI_MAIN_API_KEY" },
					models: [{ id: "gpt-5.2" }],
				},
				{
					id: "openai-fast",
					type: "custom_openai_compatible",
					base_url: "https://fast.example.test/v1",
					api_mode: "openai_responses",
					auth: { type: "secret_ref", ref: "env:OPENAI_FAST_API_KEY" },
					models: [{ id: "gpt-5.5" }],
				},
			],
		} as const;
		const primaryModel = { provider_id: "openai-fast", model: "gpt-5.5" };

		const openClawProjection = buildAgentTargetProjection("openclaw", catalog, primaryModel);
		const openClawPatch = JSON.parse(openClawProjection.files[0]?.content ?? "{}");
		expect(openClawProjection.provider_ids).toEqual(["openai-main", "openai-fast"]);
		expect(openClawPatch.agents.defaults.model.primary).toBe("openai-fast/gpt-5.5");
		expect(Object.keys(openClawPatch.models.providers)).toEqual(["openai-main", "openai-fast"]);

		const hermesProjection = buildAgentTargetProjection("hermes", catalog, primaryModel);
		const hermesPatch = hermesProjection.files[0]?.content ?? "";
		expect(hermesPatch).toContain('provider: "custom:openai-fast"');
		expect(hermesPatch).toContain('default: "gpt-5.5"');
		expect(hermesPatch).toContain('"openai-main":');
		expect(hermesPatch).toContain('"openai-fast":');
		expect(hermesPatch).not.toContain("default_model");

		const codexProjection = buildAgentTargetProjection("codex", catalog, primaryModel);
		const codexPatch = codexProjection.files[0]?.content ?? "";
		expect(codexPatch).toContain('model = "gpt-5.5"');
		expect(codexPatch).toContain('model_provider = "openai-fast"');
		expect(codexPatch).toContain('[model_providers."openai-main"]');
		expect(codexPatch).toContain('[model_providers."openai-fast"]');
	});

	it("projects user BYOK Responses providers directly to OpenClaw", async () => {
		const catalog = {
			schema_version: 1,
			providers: [
				{
					id: "custom-openai",
					type: "custom_openai_compatible",
					label: "My AI key",
					base_url: "https://sub2api.example.test/v1",
					default_model: "gpt-5.5",
					api_mode: "openai_responses",
					auth: { type: "api_key", source: "managed" },
					managed_by: "user",
					runtime_env_name: "CLAWDI_OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "custom-openai" },
		} as const;

		const projection = buildAgentTargetProjection("openclaw", catalog);
		const patch = JSON.parse(projection.files[0]!.content);

		expect(patch.agents.defaults.model.primary).toBe("custom-openai/gpt-5.5");
		expect(Object.keys(patch.models.providers)).toEqual(["custom-openai"]);
		expect(patch.models.providers["custom-openai"]).toMatchObject({
			baseUrl: "https://sub2api.example.test/v1",
			api: "openai-responses",
			apiKey: {
				source: "env",
				provider: "default",
				id: "CLAWDI_OPENAI_API_KEY",
			},
		});
		expect(patch.models.providers["custom-openai"].models[0]).toMatchObject({
			id: "gpt-5.5",
			name: "gpt-5.5",
			api: "openai-responses",
		});
		expect(JSON.stringify(patch)).not.toContain("agentRuntime");
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
			models: [{ id: "gpt-5.5" }],
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
			api_mode: "openai_responses",
			auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
			runtime_env_name: "OPENAI_API_KEY",
		});
		expect(catalog.providers[0]).not.toHaveProperty("default_model");
		expect(catalog.providers[1]).toMatchObject({
			id: "anthropic-main",
			type: "anthropic",
			base_url: "https://api.anthropic.com",
			api_mode: "anthropic_messages",
			auth: { type: "secret_ref", ref: "env:ANTHROPIC_API_KEY" },
			models: [{ id: "claude-opus-4-6" }],
			runtime_env_name: "ANTHROPIC_API_KEY",
		});
		expect(catalog.providers[1]).not.toHaveProperty("default_model");
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

async function waitForStartRedirectUri(
	captured: Array<{ path: string; body?: unknown }>,
): Promise<string> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const request = captured.find(
			(item) => item.path === "/v1/ai-providers/openai-codex/auth/oauth/start",
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
