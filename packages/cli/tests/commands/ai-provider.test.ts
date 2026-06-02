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
	aiProviderMaterializeAuthCommand,
	aiProviderRemoveCommand,
	aiProviderTestCommand,
	aiProviderValidateCommand,
} from "../../src/commands/ai-provider";
import { runtimeApplyCommand, runtimeInspectCommand } from "../../src/commands/runtime";
import { aiProviderCatalogPath } from "../../src/lib/ai-provider-catalog";
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
				runtimeEnv: "OPENAI_API_KEY",
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

	it("does not project agent profiles into key-env runtime config", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-codex", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "agent:codex/default",
				runtimeEnv: "OPENAI_API_KEY",
				json: true,
			});
			await expect(
				runtimeApplyCommand({ engine: "hermes", dryRun: true, json: true }),
			).rejects.toThrow("does not have a verified runtime projection");
		} finally {
			restore();
		}
	});

	it("dry-runs Codex apply without writing the runtime profile", async () => {
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
			await runtimeApplyCommand({ engine: "codex", dryRun: true, json: true });
		} finally {
			restore();
		}

		const profilePath = join(codexHome, "clawdi-ai-provider.config.toml");
		expect(output()).toContain('"dry_run": true');
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
			await runtimeApplyCommand({ engine: "codex", json: true });
		} finally {
			restore();
		}

		const profilePath = join(codexHome, "clawdi-ai-provider.config.toml");
		expect(readFileSync(userConfig, "utf-8")).toBe(originalConfig);
		expect(readFileSync(profilePath, "utf-8")).toContain('model_provider = "openai-main"');
		expect(readFileSync(profilePath, "utf-8")).toContain('[model_providers."openai-main"]');
		expect(readFileSync(profilePath, "utf-8")).toContain('wire_api = "responses"');
		expect(readFileSync(profilePath, "utf-8")).toContain('env_key = "OPENAI_API_KEY"');
		expect(readFileSync(profilePath, "utf-8")).toContain("@openai/codex <1.0.0");
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
			await runtimeApplyCommand({ engine: "codex", json: true });
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
			await runtimeInspectCommand({ json: true });
		} finally {
			before.restore();
		}
		expect(before.output()).toContain('"engine": "codex"');
		expect(before.output()).toContain('"applied": false');
		expect(before.output()).toContain("clawdi-ai-provider.config.toml");

		const apply = captureConsole();
		try {
			await runtimeApplyCommand({ engine: "codex", json: true });
		} finally {
			apply.restore();
		}

		const after = captureConsole();
		try {
			await runtimeInspectCommand({ json: true });
		} finally {
			after.restore();
		}
		expect(after.output()).toContain('"engine": "codex"');
		expect(after.output()).toContain('"applied": true');
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
			await runtimeApplyCommand({ engine: "codex", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(output()).toContain('model_provider = \\"openai\\"');
		expect(output()).not.toContain("env_key");
		expect(output()).not.toContain("[model_providers");
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
				runtimeApplyCommand({ engine: "codex", dryRun: true, json: true }),
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
			await runtimeApplyCommand({ engine: "codex", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(output()).toContain("Provider anthropic-main skipped for codex");
		expect(output()).toContain("Default provider anthropic-main cannot be projected to codex");
		expect(output()).toContain('model_provider = \\"openai\\"');
	});

	it("dry-runs Hermes apply without writing files or mutating config.yaml", async () => {
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const hermesConfig = join(hermesDir, "config.yaml");
		const originalConfig = 'mcp_servers:\n  clawdi:\n    command: "clawdi"\n';
		writeFileSync(hermesConfig, originalConfig);
		const { output, restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await runtimeApplyCommand({ engine: "hermes", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(readFileSync(hermesConfig, "utf-8")).toBe(originalConfig);
		expect(output()).toContain('"dry_run": true');
		expect(output()).toContain("hermes config set providers.openai-main.key_env");
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
			await runtimeApplyCommand({ engine: "hermes", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(output()).toContain('"dry_run": true');
		expect(output()).toContain("hermes config set providers.openai-main.base_url");
		expect(existsSync(logPath)).toBe(false);
	});

	it("applies Hermes through hermes config set instead of editing config.yaml directly", async () => {
		const binDir = join(tmpHome, "bin");
		mkdirSync(binDir, { recursive: true });
		const logPath = join(tmpHome, "hermes-calls.log");
		const hermesPath = join(binDir, "hermes");
		writeFileSync(hermesPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexit 0\n`, {
			mode: 0o755,
		});
		chmodSync(hermesPath, 0o755);
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		const hermesDir = join(tmpHome, ".hermes");
		mkdirSync(hermesDir, { recursive: true });
		const hermesConfig = join(hermesDir, "config.yaml");
		const originalConfig = "mcp_servers:\n  clawdi:\n    command: clawdi\n";
		writeFileSync(hermesConfig, originalConfig);
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await runtimeApplyCommand({ engine: "hermes", json: true });
		} finally {
			restore();
		}

		const calls = readFileSync(logPath, "utf-8");
		expect(calls).toContain("config set providers.openai-main.base_url https://api.openai.com/v1");
		expect(calls).toContain("config set model.provider openai-main");
		expect(calls).toContain("config set model.default gpt-5.2");
		expect(readFileSync(hermesConfig, "utf-8")).toBe(originalConfig);
	});

	it("lets Hermes apply compatible providers while skipping Codex-only auth", async () => {
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
				setDefault: true,
				json: true,
			});
			await runtimeApplyCommand({ engine: "hermes", dryRun: true, json: true });
		} finally {
			restore();
		}

		expect(output()).toContain("Provider openai-codex skipped for hermes");
		expect(output()).toContain("hermes config set providers.anthropic-main.key_env");
		expect(output()).not.toContain("hermes config set providers.openai-codex");
	});

	it("refuses Hermes apply for dotted provider ids before changing files", async () => {
		const binDir = join(tmpHome, "bin");
		mkdirSync(binDir, { recursive: true });
		const logPath = join(tmpHome, "hermes-calls.log");
		const hermesPath = join(binDir, "hermes");
		writeFileSync(hermesPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexit 0\n`, {
			mode: 0o755,
		});
		chmodSync(hermesPath, 0o755);
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai.main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await expect(runtimeApplyCommand({ engine: "hermes", json: true })).rejects.toThrow(
				"dot-path escaping has not been verified",
			);
		} finally {
			restore();
		}

		expect(existsSync(join(tmpHome, ".clawdi", "runtime", "hermes"))).toBe(false);
		expect(existsSync(logPath)).toBe(false);
	});

	it("requires default_model before runtime apply", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await expect(
				runtimeApplyCommand({ engine: "codex", dryRun: true, json: true }),
			).rejects.toThrow("requires default_model");
		} finally {
			restore();
		}
	});

	it("does not write OpenClaw files when apply is unsupported", async () => {
		const { restore } = captureConsole();
		try {
			await aiProviderAddCommand("openai-main", {
				type: "openai",
				defaultModel: "gpt-5.2",
				auth: "env:OPENAI_API_KEY",
				json: true,
			});
			await expect(runtimeApplyCommand({ engine: "openclaw", json: true })).rejects.toThrow(
				"OpenClaw apply is not enabled",
			);
		} finally {
			restore();
		}
		expect(existsSync(join(tmpHome, ".clawdi", "runtime", "openclaw"))).toBe(false);
	});

	it("imports provider metadata from a Hermes config without secrets", async () => {
		const hermesConfig = join(tmpHome, "hermes-config.yaml");
		writeFileSync(
			hermesConfig,
			[
				"model:",
				'  provider: "openai-main"',
				"providers:",
				"  openai-main:",
				'    type: "openai"',
				'    base_url: "https://api.openai.com/v1"',
				'    api_mode: "openai_responses"',
				'    model: "gpt-5.2"',
				'    key_env: "OPENAI_API_KEY"',
				"custom_providers:",
				"  openrouter-main:",
				'    name: "OpenRouter: main"',
				'    type: "openrouter"',
				'    base_url: "https://openrouter.ai/api/v1"',
				'    model: "openai/gpt-5.2"',
				'    api_key_env: "OPENROUTER_API_KEY"',
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

	it("exports and restores env secrets only through an encrypted bundle", async () => {
		process.env.OPENAI_API_KEY = "sk-backup-secret";
		process.env.CLAWDI_SECRET_BACKUP_PASSPHRASE = "correct horse battery staple";
		const backupPath = join(tmpHome, "providers.backup.json");
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
				out: backupPath,
				includeSecrets: true,
				secretPassphrase: true,
			});
			await aiProviderImportCommand(backupPath, {
				replace: true,
				restoreSecrets: "env-file",
				out: envPath,
				json: true,
			});
		} finally {
			restore();
			delete process.env.OPENAI_API_KEY;
			delete process.env.CLAWDI_SECRET_BACKUP_PASSPHRASE;
		}

		const backup = readFileSync(backupPath, "utf-8");
		expect(backup).toContain("encrypted_secrets");
		expect(backup).not.toContain("sk-backup-secret");
		expect(output()).not.toContain("sk-backup-secret");
		expect(readFileSync(envPath, "utf-8")).toBe("OPENAI_API_KEY='sk-backup-secret'\n");
	});

	it("does not restore encrypted secrets when catalog import conflicts", async () => {
		process.env.OPENAI_API_KEY = "sk-backup-secret";
		process.env.CLAWDI_SECRET_BACKUP_PASSPHRASE = "correct horse battery staple";
		const backupPath = join(tmpHome, "providers.backup.json");
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
				out: backupPath,
				includeSecrets: true,
				secretPassphrase: true,
			});
			await expect(
				aiProviderImportCommand(backupPath, {
					restoreSecrets: "env-file",
					out: envPath,
					json: true,
				}),
			).rejects.toThrow("already exists");
		} finally {
			restore();
			delete process.env.OPENAI_API_KEY;
			delete process.env.CLAWDI_SECRET_BACKUP_PASSPHRASE;
		}

		expect(existsSync(envPath)).toBe(false);
	});

	it("refuses secret export without explicit passphrase encryption", async () => {
		await expect(
			aiProviderExportCommand({ includeSecrets: true, out: "backup.json" }),
		).rejects.toThrow("--secret-passphrase");
	});

	it("requires a backup file when restoring encrypted secrets", async () => {
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
				restoreSecrets: "env-file",
				out: join(tmpHome, "providers.env"),
				json: true,
			}),
		).rejects.toThrow("--restore-secrets requires");
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
