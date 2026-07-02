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
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	runtimeApplyCommand,
	runtimePlanCommand,
	runtimeStatusCommand,
} from "../../src/commands/runtime";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-runtime-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "https://api.test";
	process.exitCode = 0;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	delete process.env.RUNTIME_PROVIDER_TOKEN;
	delete process.env.RUNTIME_WEBHOOK_SECRET;
	rmSync(tmpHome, { recursive: true, force: true });
	process.exitCode = 0;
});

describe("runtime manifest commands", () => {
	it("applies a private channel manifest and writes runtime dotenv projection", async () => {
		process.env.RUNTIME_PROVIDER_TOKEN = "provider-token";
		process.env.RUNTIME_WEBHOOK_SECRET = "verify-secret";
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: ops-telegram
    provider: telegram
    account:
      private:
        name: ops-telegram
        provider_token_env: RUNTIME_PROVIDER_TOKEN
        config:
          bot_username: opsbot
        secrets_env:
          webhook_verify_token: RUNTIME_WEBHOOK_SECRET
    links:
      - ref: ops-main
        agent_id: agent-1
        runtime:
          token_env: TELEGRAM_AGENT_TOKEN
        pair_code:
          ttl_seconds: 600
          command_env: TELEGRAM_PAIR_COMMAND
    commands:
      sync: true
outputs:
  dotenv: .env.channels
`);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels$/,
				response: () => jsonResponse([]),
			},
			{
				method: "POST",
				path: /^\/v1\/channels$/,
				response: () =>
					jsonResponse(
						{
							id: "channel-1",
							provider: "telegram",
							name: "ops-telegram",
							status: "active",
							visibility: "private",
							has_provider_token: true,
							webhook_url: "https://api.test/v1/channels/telegram/channel-1/webhook",
							created_at: "2026-06-08T00:00:00Z",
							webhook_secret: "shown-once",
						},
						201,
					),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-1\/agent-links$/,
				response: () => jsonResponse([]),
			},
			{
				method: "POST",
				path: /^\/v1\/channels\/channel-1\/agent-links$/,
				response: () =>
					jsonResponse(
						{
							id: "link-1",
							account_id: "channel-1",
							agent_id: "agent-1",
							status: "active",
							created_at: "2026-06-08T00:00:01Z",
							agent_token: "agent-token",
						},
						201,
					),
			},
			{
				method: "POST",
				path: /^\/v1\/channels\/channel-1\/pair-codes$/,
				response: () =>
					jsonResponse(
						{
							id: "pair-1",
							agent_link_id: "link-1",
							agent_id: "agent-1",
							code: "PAIR123",
							expires_at: "2026-06-08T00:10:00Z",
						},
						201,
					),
			},
			{
				method: "POST",
				path: /^\/v1\/channels\/channel-1\/commands\/sync$/,
				response: () =>
					jsonResponse({
						provider: "telegram",
						commands: [{ command: "bot_pair", description: "Pair chat" }],
					}),
			},
		]);

		const out = await captureStdout(() => runtimeApplyCommand({ file: manifestPath, json: true }));
		restore();

		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /v1/channels",
			"POST /v1/channels",
			"GET /v1/channels/channel-1/agent-links",
			"POST /v1/channels/channel-1/agent-links",
			"POST /v1/channels/channel-1/pair-codes",
			"POST /v1/channels/channel-1/commands/sync",
		]);
		expect(captured[1]?.body).toMatchObject({
			provider: "telegram",
			name: "ops-telegram",
			provider_token: "provider-token",
			config: { bot_username: "opsbot" },
			secrets: { webhook_verify_token: "verify-secret" },
		});
		expect(captured[4]?.body).toMatchObject({
			agent_link_id: "link-1",
			ttl_seconds: 600,
		});
		const dotenv = readFileSync(join(tmpHome, ".env.channels"), "utf-8");
		expect(dotenv).toContain("TELEGRAM_AGENT_TOKEN=agent-token");
		expect(dotenv).toContain("TELEGRAM_BOT_API_BASE_URL=https://api.test/v1/channels/telegram");
		expect(dotenv).toContain('TELEGRAM_PAIR_COMMAND="/bot_pair PAIR123"');
		expect(dotenv).toContain("# >>> clawdi channel runtime >>>");
		expect(dotenv).toContain("# <<< clawdi channel runtime <<<");
		expect(
			JSON.parse(out).applied.actions.map((action: { action: string }) => action.action),
		).toEqual(["create_private_account", "create_link", "create_pair_code", "sync_commands"]);
	});

	it("links an existing public account without using admin APIs", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-public
      visibility: public
    links:
      - ref: discord-main
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN
outputs:
  dotenv: .env.channels
`);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public$/,
				response: () =>
					jsonResponse({
						id: "channel-public",
						provider: "discord",
						name: "clawdi-discord",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/discord/channel-public/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public\/agent-links$/,
				response: () => jsonResponse([]),
			},
			{
				method: "POST",
				path: /^\/v1\/channels\/channel-public\/agent-links$/,
				response: () =>
					jsonResponse(
						{
							id: "link-1",
							account_id: "channel-public",
							agent_id: "agent-1",
							status: "active",
							created_at: "2026-06-08T00:00:01Z",
							agent_token: "discord-token",
						},
						201,
					),
			},
		]);

		await captureStdout(() => runtimeApplyCommand({ file: manifestPath, json: true }));
		restore();

		expect(captured.some((request) => request.path.startsWith("/v1/admin/"))).toBe(false);
		const dotenv = readFileSync(join(tmpHome, ".env.channels"), "utf-8");
		expect(dotenv).toContain("DISCORD_AGENT_TOKEN=discord-token");
		expect(dotenv).toContain("DISCORD_GATEWAY_URL=wss://api.test/v1/channels/discord/gateway");
	});

	it("does not rotate an existing link token unless explicitly requested", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-public
    links:
      - ref: discord-main
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN
outputs:
  dotenv: .env.channels
`);
		const baseHandlers = [
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public$/,
				response: () =>
					jsonResponse({
						id: "channel-public",
						provider: "discord",
						name: "clawdi-discord",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/discord/channel-public/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public\/agent-links$/,
				response: () =>
					jsonResponse([
						{
							id: "link-1",
							account_id: "channel-public",
							agent_id: "agent-1",
							status: "active",
							created_at: "2026-06-08T00:00:01Z",
						},
					]),
			},
			{
				method: "POST",
				path: /^\/v1\/channels\/channel-public\/agent-links\/link-1\/token$/,
				response: () =>
					jsonResponse({
						id: "link-1",
						account_id: "channel-public",
						agent_id: "agent-1",
						status: "active",
						created_at: "2026-06-08T00:00:01Z",
						agent_token: "rotated-token",
					}),
			},
		];
		const first = mockFetch(baseHandlers);
		const out = await captureStdout(() => runtimeApplyCommand({ file: manifestPath, json: true }));
		first.restore();

		expect(
			first.captured.some((request) => request.path.endsWith("/agent-links/link-1/token")),
		).toBe(false);
		expect(existsSync(join(tmpHome, ".env.channels"))).toBe(false);
		expect(JSON.parse(out).applied.warnings[0]).toContain("--rotate-missing-tokens");

		const second = mockFetch(baseHandlers);
		await captureStdout(() =>
			runtimeApplyCommand({
				file: manifestPath,
				rotateMissingTokens: true,
				json: true,
			}),
		);
		second.restore();

		expect(
			second.captured.some((request) => request.path.endsWith("/agent-links/link-1/token")),
		).toBe(true);
		expect(readFileSync(join(tmpHome, ".env.channels"), "utf-8")).toContain(
			"DISCORD_AGENT_TOKEN=rotated-token",
		);
	});

	it("reuses an existing dotenv token for an existing link and refreshes provider endpoints", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-public
    links:
      - ref: discord-main
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN
outputs:
  dotenv: .env.channels
`);
		writeFileSync(join(tmpHome, ".env.channels"), "DISCORD_AGENT_TOKEN=existing-token\n");
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public$/,
				response: () =>
					jsonResponse({
						id: "channel-public",
						provider: "discord",
						name: "clawdi-discord",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/discord/channel-public/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public\/agent-links$/,
				response: () =>
					jsonResponse([
						{
							id: "link-1",
							account_id: "channel-public",
							agent_id: "agent-1",
							status: "active",
							created_at: "2026-06-08T00:00:01Z",
						},
					]),
			},
		]);

		const out = await captureStdout(() => runtimeApplyCommand({ file: manifestPath, json: true }));
		restore();

		expect(captured.some((request) => request.path.endsWith("/agent-links/link-1/token"))).toBe(
			false,
		);
		expect(JSON.parse(out).applied.warnings).toEqual([]);
		const dotenv = readFileSync(join(tmpHome, ".env.channels"), "utf-8");
		expect(dotenv).toContain("DISCORD_AGENT_TOKEN=existing-token");
		expect(dotenv).toContain("DISCORD_GATEWAY_URL=wss://api.test/v1/channels/discord/gateway");
	});

	it("updates only the managed dotenv block and preserves user env lines", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-public
    links:
      - ref: discord-main
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN
outputs:
  dotenv: .env.channels
`);
		writeFileSync(join(tmpHome, ".env.channels"), "APP_ENV=dev\n");
		const { restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public$/,
				response: () =>
					jsonResponse({
						id: "channel-public",
						provider: "discord",
						name: "clawdi-discord",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/discord/channel-public/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public\/agent-links$/,
				response: () => jsonResponse([]),
			},
			{
				method: "POST",
				path: /^\/v1\/channels\/channel-public\/agent-links$/,
				response: () =>
					jsonResponse(
						{
							id: "link-1",
							account_id: "channel-public",
							agent_id: "agent-1",
							status: "active",
							created_at: "2026-06-08T00:00:01Z",
							agent_token: "discord-token",
						},
						201,
					),
			},
		]);

		await captureStdout(() => runtimeApplyCommand({ file: manifestPath, json: true }));
		restore();

		const dotenv = readFileSync(join(tmpHome, ".env.channels"), "utf-8");
		expect(dotenv).toStartWith("APP_ENV=dev\n\n# >>> clawdi channel runtime >>>");
		expect(dotenv).toContain("DISCORD_AGENT_TOKEN=discord-token");
	});

	it("plans and reports status without mutating resources", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: ops-telegram
    provider: telegram
    account:
      private:
        name: ops-telegram
    links:
      - ref: ops-main
        agent_id: agent-1
        runtime:
          token_env: TELEGRAM_AGENT_TOKEN
outputs:
  dotenv: .env.channels
`);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels$/,
				response: () =>
					jsonResponse([
						{
							id: "channel-1",
							provider: "telegram",
							name: "ops-telegram",
							status: "active",
							visibility: "private",
							has_provider_token: true,
							webhook_url: "https://api.test/v1/channels/telegram/channel-1/webhook",
							created_at: "2026-06-08T00:00:00Z",
						},
					]),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-1\/agent-links$/,
				response: () => jsonResponse([]),
			},
		]);

		const plan = await captureStdout(() => runtimePlanCommand({ file: manifestPath, json: true }));
		const status = await captureStdout(() =>
			runtimeStatusCommand({ file: manifestPath, json: true }),
		);
		restore();

		expect(captured.every((request) => request.method === "GET")).toBe(true);
		expect(JSON.parse(plan).plan.links[0].action).toBe("create_link");
		expect(JSON.parse(status).status.accounts[0].action).toBe("reuse_account");
	});

	it("plans existing account ids by resolving the account directly", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-public
    links:
      - ref: discord-main
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN
outputs:
  dotenv: .env.channels
`);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public$/,
				response: () =>
					jsonResponse({
						id: "channel-public",
						provider: "discord",
						name: "clawdi-discord",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/discord/channel-public/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public\/agent-links$/,
				response: () => jsonResponse([]),
			},
		]);

		const plan = await captureStdout(() => runtimePlanCommand({ file: manifestPath, json: true }));
		restore();

		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /v1/channels/channel-public",
			"GET /v1/channels/channel-public/agent-links",
		]);
		expect(JSON.parse(plan).plan.accounts[0].action).toBe("reuse_account");
		expect(JSON.parse(plan).plan.warnings).toEqual([]);
	});

	it("rejects existing account ids with the wrong provider during planning", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-telegram
    links:
      - ref: discord-main
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN
outputs:
  dotenv: .env.channels
`);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-telegram$/,
				response: () =>
					jsonResponse({
						id: "channel-telegram",
						provider: "telegram",
						name: "clawdi-telegram",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/telegram/channel-telegram/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
		]);

		await expect(runtimePlanCommand({ file: manifestPath, json: true })).rejects.toThrow(
			"public-discord: account channel-telegram is provider telegram, expected discord.",
		);
		restore();
	});

	it("rejects malformed manifests before API calls", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: bad
    provider: slack
    account:
      id: account-1
    links: []
`);
		const { captured, restore } = mockFetch([]);
		await expect(runtimeApplyCommand({ file: manifestPath, json: true })).rejects.toThrow(
			"Invalid runtime manifest",
		);
		restore();

		expect(captured).toHaveLength(0);
	});

	it("writes WhatsApp Baileys credentials when requested", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: wa
    provider: whatsapp
    account:
      id: channel-wa
    links:
      - ref: wa-main
        agent_id: agent-1
        runtime:
          token_env: WHATSAPP_AGENT_TOKEN
        whatsapp:
          baileys_credentials_dir: .wa-creds
outputs:
  dotenv: .env.channels
	`);
		const credsDir = join(tmpHome, ".wa-creds");
		mkdirSync(credsDir, { recursive: true, mode: 0o755 });
		if (process.platform !== "win32") chmodSync(credsDir, 0o755);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-wa$/,
				response: () =>
					jsonResponse({
						id: "channel-wa",
						provider: "whatsapp",
						name: "wa",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/whatsapp/channel-wa/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-wa\/agent-links$/,
				response: () =>
					jsonResponse([
						{
							id: "link-1",
							account_id: "channel-wa",
							agent_id: "agent-1",
							status: "active",
							created_at: "2026-06-08T00:00:01Z",
							agent_token: "wa-token",
						},
					]),
			},
			{
				method: "POST",
				path: /^\/v1\/channels\/whatsapp\/channel-wa\/tenant-creds$/,
				response: () =>
					jsonResponse(
						{
							channel: "whatsapp",
							credential_id: "cred-1",
							agent_link_id: "link-1",
							agent_id: "agent-1",
							jid: "1@s.whatsapp.net",
							identity_pub_key_hex: "abcd",
							creds: { noiseKey: "n" },
							auth_cert: { cert: "c" },
							websocket_url: "wss://api.test/v1/channels/whatsapp/channel-wa/baileys",
							media_proxy_base_url: "https://api.test/v1/channels/whatsapp/media",
						},
						201,
					),
			},
		]);

		await captureStdout(() => runtimeApplyCommand({ file: manifestPath, json: true }));
		restore();

		expect(JSON.parse(readFileSync(join(tmpHome, ".wa-creds", "creds.json"), "utf-8"))).toEqual({
			noiseKey: "n",
		});
		expect(readFileSync(join(tmpHome, ".env.channels"), "utf-8")).toContain(
			"WHATSAPP_AGENT_TOKEN=wa-token",
		);
		expect(readFileSync(join(tmpHome, ".env.channels"), "utf-8")).toContain(
			`CLAWDI_WHATSAPP_AUTH_DIR=${join(tmpHome, ".wa-creds")}`,
		);
		if (process.platform !== "win32") {
			expect(statSync(credsDir).mode & 0o777).toBe(0o700);
		}
	});

	it("requires explicit confirmation before rotating every declared token", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-public
    links:
      - ref: discord-main
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN
outputs:
  dotenv: .env.channels
`);
		const { captured, restore } = mockFetch([]);
		await expect(
			runtimeApplyCommand({ file: manifestPath, rotateAllTokens: true, json: true }),
		).rejects.toThrow("--yes");
		restore();

		expect(captured).toHaveLength(0);
	});

	it("rejects unsafe manifests that have no explicit dotenv output", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-public
    links:
      - ref: discord-main
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN
`);
		const { captured, restore } = mockFetch([]);
		await expect(runtimePlanCommand({ file: manifestPath, json: true })).rejects.toThrow(
			"Invalid runtime manifest",
		);
		restore();

		expect(captured).toHaveLength(0);
	});

	it("rejects duplicate link refs and env outputs before API calls", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-public
    links:
      - ref: shared
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN
        pair_code:
          command_env: DISCORD_AGENT_TOKEN
      - ref: shared
        agent_id: agent-2
        runtime:
          token_env: DISCORD_AGENT_TOKEN
outputs:
  dotenv: .env.channels
`);
		const { captured, restore } = mockFetch([]);
		await expect(runtimeApplyCommand({ file: manifestPath, json: true })).rejects.toThrow(
			"Invalid runtime manifest",
		);
		restore();

		expect(captured).toHaveLength(0);
	});

	it("preflights channel-specific runtime env conflicts before API calls", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: wa-a
    provider: whatsapp
    account:
      id: channel-wa-a
    links:
      - ref: wa-a-main
        agent_id: agent-1
        runtime:
          token_env: WHATSAPP_AGENT_TOKEN_A
  - ref: wa-b
    provider: whatsapp
    account:
      id: channel-wa-b
    links:
      - ref: wa-b-main
        agent_id: agent-2
        runtime:
          token_env: WHATSAPP_AGENT_TOKEN_B
outputs:
  dotenv: .env.channels
`);
		const { captured, restore } = mockFetch([]);
		await expect(runtimeApplyCommand({ file: manifestPath, json: true })).rejects.toThrow(
			"Runtime output WA_WEBSOCKET_URL has conflicting values before apply",
		);
		restore();

		expect(captured).toHaveLength(0);
		expect(existsSync(join(tmpHome, ".env.channels"))).toBe(false);
	});

	it("allows explicit env names for multiple WhatsApp runtime accounts", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: wa-a
    provider: whatsapp
    account:
      id: channel-wa-a
    links:
      - ref: wa-a-main
        agent_id: agent-1
        runtime:
          token_env: WHATSAPP_AGENT_TOKEN_A
          env:
            websocket_url: WA_A_WEBSOCKET_URL
  - ref: wa-b
    provider: whatsapp
    account:
      id: channel-wa-b
    links:
      - ref: wa-b-main
        agent_id: agent-2
        runtime:
          token_env: WHATSAPP_AGENT_TOKEN_B
          env:
            websocket_url: WA_B_WEBSOCKET_URL
outputs:
  dotenv: .env.channels
`);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-wa-a$/,
				response: () =>
					jsonResponse({
						id: "channel-wa-a",
						provider: "whatsapp",
						name: "wa-a",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/whatsapp/channel-wa-a/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-wa-a\/agent-links$/,
				response: () =>
					jsonResponse([
						{
							id: "link-a",
							account_id: "channel-wa-a",
							agent_id: "agent-1",
							status: "active",
							created_at: "2026-06-08T00:00:01Z",
							agent_token: "token-a",
						},
					]),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-wa-b$/,
				response: () =>
					jsonResponse({
						id: "channel-wa-b",
						provider: "whatsapp",
						name: "wa-b",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/whatsapp/channel-wa-b/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-wa-b\/agent-links$/,
				response: () =>
					jsonResponse([
						{
							id: "link-b",
							account_id: "channel-wa-b",
							agent_id: "agent-2",
							status: "active",
							created_at: "2026-06-08T00:00:01Z",
							agent_token: "token-b",
						},
					]),
			},
		]);

		await captureStdout(() => runtimeApplyCommand({ file: manifestPath, json: true }));
		restore();

		expect(captured).toHaveLength(4);
		const dotenv = readFileSync(join(tmpHome, ".env.channels"), "utf-8");
		expect(dotenv).toContain(
			"WA_A_WEBSOCKET_URL=wss://api.test/v1/channels/whatsapp/channel-wa-a/baileys",
		);
		expect(dotenv).toContain(
			"WA_B_WEBSOCKET_URL=wss://api.test/v1/channels/whatsapp/channel-wa-b/baileys",
		);
	});

	it("reuses account link reads across multiple links for the same bot", async () => {
		const manifestPath = writeManifest(`
version: 1
channels:
  - ref: public-discord
    provider: discord
    account:
      id: channel-public
    links:
      - ref: discord-a
        agent_id: agent-1
        runtime:
          token_env: DISCORD_AGENT_TOKEN_A
      - ref: discord-b
        agent_id: agent-2
        runtime:
          token_env: DISCORD_AGENT_TOKEN_B
outputs:
  dotenv: .env.channels
`);
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public$/,
				response: () =>
					jsonResponse({
						id: "channel-public",
						provider: "discord",
						name: "clawdi-discord",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://api.test/v1/channels/discord/channel-public/webhook",
						created_at: "2026-06-08T00:00:00Z",
					}),
			},
			{
				method: "GET",
				path: /^\/v1\/channels\/channel-public\/agent-links$/,
				response: () => jsonResponse([]),
			},
			{
				method: "POST",
				path: /^\/v1\/channels\/channel-public\/agent-links$/,
				response: () => {
					const count = captured.filter(
						(request) =>
							request.method === "POST" &&
							request.path === "/v1/channels/channel-public/agent-links",
					).length;
					return jsonResponse(
						{
							id: `link-${count}`,
							account_id: "channel-public",
							agent_id: count === 1 ? "agent-1" : "agent-2",
							status: "active",
							created_at: "2026-06-08T00:00:01Z",
							agent_token: `token-${count}`,
						},
						201,
					);
				},
			},
		]);

		await captureStdout(() => runtimeApplyCommand({ file: manifestPath, json: true }));
		restore();

		expect(
			captured.filter(
				(request) =>
					request.method === "GET" && request.path === "/v1/channels/channel-public/agent-links",
			),
		).toHaveLength(1);
		const dotenv = readFileSync(join(tmpHome, ".env.channels"), "utf-8");
		expect(dotenv).toContain("DISCORD_AGENT_TOKEN_A=token-1");
		expect(dotenv).toContain("DISCORD_AGENT_TOKEN_B=token-2");
	});
});

function writeManifest(content: string): string {
	const path = join(tmpHome, "clawdi.runtime.yaml");
	writeFileSync(path, content.trimStart());
	return path;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const original = console.log;
	const chunks: string[] = [];
	console.log = (...args: unknown[]) => chunks.push(args.join(" "));
	try {
		await fn();
	} finally {
		console.log = original;
	}
	return chunks.join("\n");
}
