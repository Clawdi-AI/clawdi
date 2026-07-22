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
	assertCurrentEgressIdentity,
	buildEgressEngineSpawnCommand,
	publishEgressSystemCaBundle,
	runtimeApplyCommand,
	runtimePlanCommand,
	runtimeStatusCommand,
} from "../../src/commands/runtime";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

describe("runtime sidecar egress privilege drop", () => {
	it("prefers setpriv with an explicit non-root numeric identity", () => {
		expect(
			buildEgressEngineSpawnCommand(
				(command) => command === "setpriv" || command === "gosu",
				10002,
				10003,
				"/opt/mitmdump",
				["--mode", "transparent"],
			),
		).toEqual({
			command: "setpriv",
			args: [
				"--reuid=10002",
				"--regid=10003",
				"--clear-groups",
				"--",
				"/opt/mitmdump",
				"--mode",
				"transparent",
			],
		});
	});

	it("uses a numeric gosu identity and never runuser", () => {
		const checked: string[] = [];
		const child = buildEgressEngineSpawnCommand(
			(command) => {
				checked.push(command);
				return command === "gosu";
			},
			10002,
			10003,
			"/opt/mitmdump",
			[],
		);

		expect(child).toEqual({
			command: "gosu",
			args: ["10002:10003", "/opt/mitmdump"],
		});
		expect(checked).toEqual(["setpriv", "gosu"]);
	});

	it("fails closed for root or unavailable privilege-drop tools", () => {
		expect(() => buildEgressEngineSpawnCommand(() => true, 0, 10002, "mitmdump", [])).toThrow(
			"egress engine identity must be non-root",
		);
		expect(() => buildEgressEngineSpawnCommand(() => false, 10002, 10002, "mitmdump", [])).toThrow(
			"install setpriv or gosu",
		);
	});

	it("allows a matching non-root current identity", () => {
		expect(() => assertCurrentEgressIdentity(10002, 10003, 10002, 10003)).not.toThrow();
	});

	it("rejects mismatching or unverifiable non-root current identities", () => {
		expect(() => assertCurrentEgressIdentity(10001, 10001, 10002, 10002)).toThrow(
			"current egress engine identity 10001:10001 does not match configured 10002:10002",
		);
		expect(() => assertCurrentEgressIdentity(undefined, 10002, 10002, 10002)).toThrow(
			"cannot verify non-root egress engine UID/GID",
		);
		expect(() => assertCurrentEgressIdentity(10002, 0, 10002, 10002)).toThrow(
			"egress engine identity must be non-root",
		);
	});
});

describe("runtime sidecar egress CA projection", () => {
	it("creates and overwrites the runtime-readable bundle as root:runtime-group 0640", () => {
		const root = join(tmpdir(), `clawdi-egress-ca-${Date.now()}-${Math.random().toString(36)}`);
		const caCertPath = join(root, "private", "mitmproxy-ca-cert.pem");
		const systemCaBundle = join(root, "published", "ca.pem");
		const runtimeGid = process.getuid?.() === 0 ? 12_345 : (process.getgid?.() ?? 0);
		const config = {
			runtimeUser: "clawdi",
			runtimeUid: 10_001,
			runtimeGid,
			egressUid: 10_002,
			egressGid: 10_002,
			transparentPort: 25_080,
			nftTable: "clawdi_transparent_egress",
			profileBundlePath: join(root, "profiles.json"),
			secretFilePath: join(root, "secrets.json"),
			caDir: join(root, "private"),
			caCertPath,
			systemCaBundle,
			engineVersion: "test",
			engineUrl: "https://example.invalid/mitmproxy.tar.gz",
			engineSha256: "a".repeat(64),
			engineBinaryPath: join(root, "mitmdump"),
			addonPath: join(root, "addon.py"),
			addonSha256: "b".repeat(64),
		};

		try {
			mkdirSync(join(root, "private"), { recursive: true });
			writeFileSync(caCertPath, "first-egress-ca\n");
			publishEgressSystemCaBundle(config);
			const created = statSync(systemCaBundle);
			expect(created.mode & 0o777).toBe(0o640);
			expect(readFileSync(systemCaBundle, "utf-8")).toContain("first-egress-ca");
			if (process.getuid?.() === 0) {
				expect(created.uid).toBe(0);
				expect(created.gid).toBe(runtimeGid);
			}

			chmodSync(systemCaBundle, 0o666);
			writeFileSync(caCertPath, "rotated-egress-ca\n");
			publishEgressSystemCaBundle(config);
			const overwritten = statSync(systemCaBundle);
			expect(overwritten.mode & 0o777).toBe(0o640);
			expect(readFileSync(systemCaBundle, "utf-8")).toContain("rotated-egress-ca");
			if (process.getuid?.() === 0) {
				expect(overwritten.uid).toBe(0);
				expect(overwritten.gid).toBe(runtimeGid);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

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

	it("skips WhatsApp Baileys credentials while upstream support is gated", async () => {
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
		const { captured, restore } = mockFetch([
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
		]);

		await captureStdout(() => runtimeApplyCommand({ file: manifestPath, json: true }));
		restore();

		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /v1/channels/channel-wa",
			"GET /v1/channels/channel-wa/agent-links",
		]);
		expect(existsSync(join(tmpHome, ".wa-creds", "creds.json"))).toBe(false);
		expect(existsSync(join(tmpHome, ".wa-creds", "auth-cert.json"))).toBe(false);
		expect(existsSync(join(tmpHome, ".wa-creds", "clawdi-whatsapp.json"))).toBe(false);
		expect(existsSync(join(tmpHome, ".env.channels"))).toBe(false);
		if (process.platform !== "win32") {
			expect(statSync(credsDir).mode & 0o777).toBe(0o755);
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

	it("skips WhatsApp runtime env conflict preflight while upstream support is gated", async () => {
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
		expect(existsSync(join(tmpHome, ".env.channels"))).toBe(false);
	});

	it("skips explicit WhatsApp runtime env names while upstream support is gated", async () => {
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
		expect(existsSync(join(tmpHome, ".env.channels"))).toBe(false);
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
