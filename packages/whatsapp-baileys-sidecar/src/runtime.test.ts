import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAuthCreds, proto } from "baileys";

import { parseAuditedWhatsAppWebVersion } from "./audited-version.js";
import type { SidecarConfig } from "./config.js";
import { BaileysSocketRuntime, type ProviderSocketFactory } from "./runtime.js";
import type { ProviderMessageEventInput } from "./sqlite-state.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("physical Baileys runtime", () => {
	it("passes the exact audited Web version to makeWASocket without dynamic discovery", async () => {
		const harness = createHarness();
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);

		await runtime.start();

		expect(harness.socketConfigurations).toHaveLength(1);
		expect(harness.socketConfigurations[0]?.version).toEqual([2, 3000, 1_035_194_821]);
		const runtimeSource = readFileSync(new URL("runtime.ts", import.meta.url), "utf8");
		expect(runtimeSource).not.toContain("fetchLatestBaileysVersion");
		expect(runtimeSource).not.toContain("useMultiFileAuthState");
		await runtime.stop();
	});

	it("persists creds.update and fail-stops the socket on auth persistence failure", async () => {
		const harness = createHarness({ failCredsWrite: true });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });
		expect(runtime.health().connected).toBe(true);

		harness.events.emit("creds.update", { registered: true });

		expect(harness.credsUpdates).toEqual([{ registered: true }]);
		expect(harness.endedErrors).toHaveLength(1);
		expect(runtime.health()).toMatchObject({
			status: "disconnected",
			connected: false,
			lastDisconnectReason: "auth_state_persistence_failed",
		});
		await runtime.stop();
	});

	it("persists an inbound batch synchronously before the event handler returns", async () => {
		const order: string[] = [];
		const harness = createHarness({
			onAppendProviderEvents: () => order.push("persisted"),
		});
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();

		harness.events.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: {
						id: "provider-message-1",
						remoteJid: "15550001111@s.whatsapp.net",
						fromMe: false,
					},
					pushName: "Provider sender",
					messageTimestamp: 123,
					message: { conversation: "hello" },
				},
			],
		});
		order.push("handler-returned");

		expect(order).toEqual(["persisted", "handler-returned"]);
		expect(harness.providerEventBatches).toHaveLength(1);
		expect(harness.providerEventBatches[0]?.[0]).toMatchObject({
			eventType: "messages.upsert",
			messageId: "provider-message-1",
			remoteJid: "15550001111@s.whatsapp.net",
			fromMe: false,
			pushName: "Provider sender",
			messageTimestamp: 123,
		});
		expect(
			proto.Message.decode(
				Buffer.from(harness.providerEventBatches[0]?.[0]?.messageProtoBase64 ?? "", "base64"),
			).conversation,
		).toBe("hello");
		await runtime.stop();
	});

	it("fail-stops instead of dropping an inbound event when spool persistence fails", async () => {
		const harness = createHarness({ failInboxWrite: true });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });

		harness.events.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: {
						id: "provider-message-1",
						remoteJid: "15550001111@s.whatsapp.net",
						fromMe: false,
					},
					message: { conversation: "must-not-drop" },
				},
			],
		});

		expect(harness.endedErrors).toHaveLength(1);
		expect(runtime.health()).toMatchObject({
			status: "disconnected",
			connected: false,
			lastDisconnectReason: "provider_inbox_persistence_failed",
		});
		await runtime.stop();
	});

	it("fail-stops the real SQLite-backed runtime when inbox capacity is exhausted", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-runtime-capacity-"));
		const harness = createHarness();
		const config = {
			...sidecarConfig(),
			sessionDir,
			providerInbox: { maxEvents: 1, maxBytes: 32 },
		};
		const runtime = new BaileysSocketRuntime(config, {
			socketFactory: harness.dependencies.socketFactory,
		});
		try {
			await runtime.start();
			harness.events.emit("connection.update", { connection: "open" });

			harness.events.emit("messages.upsert", {
				type: "notify",
				messages: [
					{
						key: {
							id: "provider-message-over-capacity",
							remoteJid: "15550001111@s.whatsapp.net",
							fromMe: false,
						},
						message: { conversation: "must-fail-stop" },
					},
				],
			});

			expect(harness.endedErrors).toHaveLength(1);
			expect(runtime.health()).toMatchObject({
				status: "disconnected",
				connected: false,
				lastDisconnectReason: "provider_inbox_persistence_failed",
			});
		} finally {
			await runtime.stop();
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("durably stores exact retry proto before calling the physical relay", async () => {
		const order: string[] = [];
		const harness = createHarness({
			onStoreRetryMessage: () => order.push("retry-stored"),
			onRelayMessage: () => order.push("relayed"),
		});
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });
		const encoded = proto.Message.encode({ conversation: "outbound" }).finish();

		await runtime.relayMessage({
			jid: "15550002222@s.whatsapp.net",
			messageId: "outbound-1",
			messageProto: encoded,
			additionalAttributes: { addressing_mode: "lid" },
		});

		expect(order).toEqual(["retry-stored", "relayed"]);
		expect(harness.retryMessages).toEqual([
			{
				remoteJid: "15550002222@s.whatsapp.net",
				messageId: "outbound-1",
				message: Buffer.from(encoded),
			},
		]);
		await runtime.stop();
	});

	it("fail-stops on retry persistence failure and never calls the physical relay", async () => {
		const harness = createHarness({ failRetryWrite: true });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });
		const encoded = proto.Message.encode({ conversation: "outbound" }).finish();

		await expect(
			runtime.relayMessage({
				jid: "15550002222@s.whatsapp.net",
				messageId: "outbound-1",
				messageProto: encoded,
				additionalAttributes: {},
			}),
		).rejects.toThrow("injected retry write failure");
		expect(harness.relayRequests).toEqual([]);
		expect(harness.endedErrors).toHaveLength(1);
		expect(runtime.health().lastDisconnectReason).toBe("provider_retry_state_persistence_failed");
		await runtime.stop();
	});
});

type HarnessOptions = {
	failCredsWrite?: boolean;
	failInboxWrite?: boolean;
	failRetryWrite?: boolean;
	onAppendProviderEvents?: () => void;
	onStoreRetryMessage?: () => void;
	onRelayMessage?: () => void;
};

function createHarness(options: HarnessOptions = {}) {
	const events = new EventEmitter();
	const credsUpdates: Array<Record<string, unknown>> = [];
	const providerEventBatches: ProviderMessageEventInput[][] = [];
	const retryMessages: Array<{ remoteJid: string; messageId: string; message: Buffer }> = [];
	const relayRequests: Array<{ jid: string; messageId?: string }> = [];
	const endedErrors: Error[] = [];
	const socketConfigurations: Array<Parameters<ProviderSocketFactory>[0]> = [];
	let stateClosed = false;
	const providerState = {
		state: {
			creds: initAuthCreds(),
			keys: {
				async get() {
					return {};
				},
				async set() {},
				async clear() {},
			},
		},
		retryCounterCache: {
			get<T>(): T | undefined {
				return undefined;
			},
			set() {},
			del() {},
			flushAll() {},
		},
		saveCreds(update = {}) {
			credsUpdates.push(update);
			if (options.failCredsWrite) throw new Error("injected creds write failure");
		},
		storeRetryMessage(remoteJid: string, messageId: string, message: Uint8Array) {
			retryMessages.push({ remoteJid, messageId, message: Buffer.from(message) });
			options.onStoreRetryMessage?.();
			if (options.failRetryWrite) throw new Error("injected retry write failure");
		},
		getRetryMessage() {
			return undefined;
		},
		appendProviderEvents(batch: readonly ProviderMessageEventInput[]) {
			providerEventBatches.push([...batch]);
			options.onAppendProviderEvents?.();
			if (options.failInboxWrite) throw new Error("injected inbox write failure");
		},
		providerEvents() {
			return [];
		},
		acknowledgeProviderEvents() {},
		close() {
			stateClosed = true;
		},
	};
	const socketFactory: ProviderSocketFactory = (configuration) => {
		socketConfigurations.push(configuration);
		return {
			user: undefined,
			ev: events,
			async end(error) {
				endedErrors.push(error ?? new Error("socket ended"));
			},
			async relayMessage(jid, _message, relayOptions) {
				relayRequests.push({
					jid,
					...(relayOptions.messageId ? { messageId: relayOptions.messageId } : {}),
				});
				options.onRelayMessage?.();
				return relayOptions.messageId ?? "generated-message-id";
			},
			async sendNode() {},
			async query() {
				return { tag: "iq", attrs: { type: "result" } };
			},
		};
	};
	return {
		dependencies: { socketFactory, providerState },
		events,
		credsUpdates,
		providerEventBatches,
		retryMessages,
		relayRequests,
		endedErrors,
		socketConfigurations,
		get stateClosed() {
			return stateClosed;
		},
	};
}

function sidecarConfig(): SidecarConfig {
	return {
		accountId: ACCOUNT_ID,
		host: "127.0.0.1",
		port: 8787,
		apiToken: "test-token",
		sessionDir: "/unused/in-memory-test-state",
		logLevel: "silent",
		webVersion: parseAuditedWhatsAppWebVersion("2.3000.1035194821"),
		providerInbox: { maxEvents: 100, maxBytes: 1024 * 1024 },
	};
}
