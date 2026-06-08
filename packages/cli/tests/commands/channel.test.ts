import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	channelCreateCommand,
	channelDeleteCommand,
	channelGetCommand,
	channelLinkCommand,
	channelPairCodeCommand,
	channelRotateTokenCommand,
	channelSendCommand,
	channelSyncCommandsCommand,
} from "../../src/commands/channel";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-channel-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://api.test";
	process.exitCode = 0;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpHome, { recursive: true, force: true });
	process.exitCode = 0;
});

describe("channel commands", () => {
	it("creates a private channel bot with optional initial agent link", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/channels",
				response: () =>
					jsonResponse(
						{
							id: "channel-1",
							provider: "telegram",
							name: "ops-bot",
							status: "active",
							visibility: "private",
							has_provider_token: true,
							webhook_url: "https://api.test/api/channels/telegram/channel-1/webhook",
							created_at: new Date().toISOString(),
							webhook_secret: "secret",
							agent_link_id: "link-1",
							agent_id: "agent-1",
							agent_token: "123:mock",
						},
						201,
					),
			},
		]);
		const out = await captureStdout(() =>
			channelCreateCommand("telegram", "ops-bot", {
				agent: "agent-1",
				providerToken: "provider-token",
				config: '{"bot_username":"ops"}',
				secret: ["app_secret=shh"],
				json: true,
			}),
		);
		restore();

		expect(captured[0]).toMatchObject({
			method: "POST",
			path: "/api/channels",
			body: {
				provider: "telegram",
				name: "ops-bot",
				agent_id: "agent-1",
				provider_token: "provider-token",
				config: { bot_username: "ops" },
				secrets: { app_secret: "shh" },
			},
		});
		expect(JSON.parse(out)).toMatchObject({
			channel: { id: "channel-1", agent_link_id: "link-1", agent_token: "123:mock" },
		});
	});

	it("creates a private channel bot with provider token and secrets from env", async () => {
		process.env.CLAWDI_TEST_PROVIDER_TOKEN = "provider-token-from-env";
		process.env.CLAWDI_TEST_PROVIDER_SECRET = "secret-from-env";
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/channels",
				response: () =>
					jsonResponse(
						{
							id: "channel-1",
							provider: "telegram",
							name: "ops-bot",
							status: "active",
							visibility: "private",
							has_provider_token: true,
							webhook_url: "https://api.test/api/channels/telegram/channel-1/webhook",
							created_at: new Date().toISOString(),
							webhook_secret: "secret",
						},
						201,
					),
			},
		]);

		try {
			await captureStdout(() =>
				channelCreateCommand("telegram", "ops-bot", {
					providerTokenEnv: "CLAWDI_TEST_PROVIDER_TOKEN",
					secretEnv: ["app_secret=CLAWDI_TEST_PROVIDER_SECRET"],
					json: true,
				}),
			);
		} finally {
			restore();
			delete process.env.CLAWDI_TEST_PROVIDER_TOKEN;
			delete process.env.CLAWDI_TEST_PROVIDER_SECRET;
		}

		expect(captured[0]).toMatchObject({
			method: "POST",
			path: "/api/channels",
			body: {
				provider_token: "provider-token-from-env",
				secrets: { app_secret: "secret-from-env" },
			},
		});
	});

	it("shows channel details", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/api/channels/channel-1",
				response: () =>
					jsonResponse({
						id: "channel-1",
						provider: "telegram",
						name: "ops-bot",
						status: "active",
						visibility: "private",
						has_provider_token: true,
						webhook_url: "https://api.test/api/channels/telegram/channel-1/webhook",
						created_at: new Date().toISOString(),
					}),
			},
		]);
		const out = await captureStdout(() => channelGetCommand("channel-1", { json: true }));
		restore();

		expect(captured[0]).toMatchObject({ method: "GET", path: "/api/channels/channel-1" });
		expect(JSON.parse(out)).toMatchObject({
			channel: { id: "channel-1", provider: "telegram", visibility: "private" },
		});
	});

	it("links an accessible channel to an agent", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/channels/channel-1/agent-links",
				response: () =>
					jsonResponse(
						{
							id: "link-1",
							account_id: "channel-1",
							agent_id: "agent-1",
							status: "active",
							created_at: new Date().toISOString(),
							agent_token: "mock-token",
						},
						201,
					),
			},
		]);
		const out = await captureStdout(() =>
			channelLinkCommand("channel-1", { agent: "agent-1", json: true }),
		);
		restore();

		expect(captured[0]).toMatchObject({
			method: "POST",
			path: "/api/channels/channel-1/agent-links",
			body: { agent_id: "agent-1" },
		});
		expect(JSON.parse(out)).toMatchObject({
			link: { id: "link-1", account_id: "channel-1", agent_id: "agent-1" },
		});
	});

	it("rotates an agent link token", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/channels/channel-1/agent-links/link-1/token",
				response: () =>
					jsonResponse({
						id: "link-1",
						account_id: "channel-1",
						agent_id: "agent-1",
						status: "active",
						created_at: new Date().toISOString(),
						agent_token: "rotated-token",
					}),
			},
		]);
		const out = await captureStdout(() =>
			channelRotateTokenCommand("channel-1", { link: "link-1", json: true }),
		);
		restore();

		expect(captured[0]).toMatchObject({
			method: "POST",
			path: "/api/channels/channel-1/agent-links/link-1/token",
		});
		expect(JSON.parse(out)).toMatchObject({
			link: { id: "link-1", agent_token: "rotated-token" },
		});
	});

	it("creates a pair code for an existing bot-agent link", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/channels/channel-1/pair-codes",
				response: () =>
					jsonResponse(
						{
							id: "pair-1",
							agent_link_id: "link-1",
							agent_id: "agent-1",
							agent_token: null,
							code: "PAIR12345678",
							expires_at: new Date().toISOString(),
						},
						201,
					),
			},
		]);
		const out = await captureStdout(() =>
			channelPairCodeCommand("channel-1", { link: "link-1", ttl: "600", json: true }),
		);
		restore();

		expect(captured[0]).toMatchObject({
			method: "POST",
			path: "/api/channels/channel-1/pair-codes",
			body: { agent_id: null, agent_link_id: "link-1", ttl_seconds: 600 },
		});
		expect(JSON.parse(out)).toMatchObject({
			pair_code: { code: "PAIR12345678", agent_link_id: "link-1" },
		});
	});

	it("rejects pair-code requests that pass both agent and link", async () => {
		const origError = console.error;
		let err = "";
		console.error = (...args: unknown[]) => {
			err = args.map(String).join(" ");
		};
		try {
			await channelPairCodeCommand("channel-1", {
				agent: "agent-1",
				link: "link-1",
			});
		} finally {
			console.error = origError;
		}

		expect(process.exitCode).toBe(1);
		expect(err).toContain("Pass either --agent or --link, not both.");
	});

	it("queues an outbound message by binding id", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/channels/channel-1/messages",
				response: () =>
					jsonResponse(
						{
							id: "message-1",
							direction: "outbound",
							external_chat_id: "chat-1",
							provider_message_id: null,
							delivery_id: "delivery-1",
							delivery_status: "pending",
							text: "deploy done",
							created_at: new Date().toISOString(),
						},
						201,
					),
			},
		]);
		const out = await captureStdout(() =>
			channelSendCommand("channel-1", {
				binding: "binding-1",
				text: "deploy done",
				json: true,
			}),
		);
		restore();

		expect(captured[0]).toMatchObject({
			method: "POST",
			path: "/api/channels/channel-1/messages",
			body: { binding_id: "binding-1", external_chat_id: null, text: "deploy done" },
		});
		expect(JSON.parse(out)).toMatchObject({
			message: { id: "message-1", delivery_status: "pending" },
		});
	});

	it("rejects send requests with both binding and chat", async () => {
		const origError = console.error;
		let err = "";
		console.error = (...args: unknown[]) => {
			err = args.map(String).join(" ");
		};
		try {
			await channelSendCommand("channel-1", {
				binding: "binding-1",
				chat: "chat-1",
				text: "hello",
			});
		} finally {
			console.error = origError;
		}

		expect(process.exitCode).toBe(1);
		expect(err).toContain("Pass either --binding or --chat, not both.");
	});

	it("syncs provider commands", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/channels/channel-1/commands/sync",
				response: () =>
					jsonResponse({
						provider: "discord",
						commands: [{ name: "bot_pair", description: "Pair this chat with Clawdi." }],
					}),
			},
		]);
		const out = await captureStdout(() =>
			channelSyncCommandsCommand("channel-1", {
				guild: "guild-1",
				commands: '[{"name":"bot_pair","description":"Pair"}]',
				json: true,
			}),
		);
		restore();

		expect(captured[0]).toMatchObject({
			method: "POST",
			path: "/api/channels/channel-1/commands/sync",
			body: {
				guild_id: "guild-1",
				commands: [{ name: "bot_pair", description: "Pair" }],
			},
		});
		expect(JSON.parse(out)).toMatchObject({ sync: { provider: "discord" } });
	});

	it("archives a private channel bot with explicit confirmation", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "DELETE",
				path: "/api/channels/channel-1",
				response: () => new Response(null, { status: 204 }),
			},
		]);
		const out = await captureStdout(() =>
			channelDeleteCommand("channel-1", { yes: true, json: true }),
		);
		restore();

		expect(captured[0]).toMatchObject({ method: "DELETE", path: "/api/channels/channel-1" });
		expect(JSON.parse(out)).toEqual({ account_id: "channel-1", deleted: true });
	});
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const orig = console.log;
	let out = "";
	console.log = (...args: unknown[]) => {
		out = args.map(String).join(" ");
	};
	try {
		await fn();
	} finally {
		console.log = orig;
	}
	return out;
}
