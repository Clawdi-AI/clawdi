import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BaileysEventMap, WAMessage } from "baileys";
import pino from "pino";

import { ClawdiCallbackDeliveryQueue } from "./callback.js";
import {
	type BaileysInboundCallbackSource,
	BaileysSocketRuntime,
	reconnectDelayMs,
	recordProviderSentMessage,
	registerBaileysInboundCallbackListener,
	resolveQuotedMessage,
	sendTextThroughSocket,
	shouldReconnectAfterClose,
} from "./runtime.js";
import { SQLiteBaileysState } from "./sqlite-state.js";

type MessagesUpsert = BaileysEventMap["messages.upsert"];
const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeBaileysInboundSocket implements BaileysInboundCallbackSource {
	private listener: ((upsert: MessagesUpsert) => void) | null = null;
	readonly endReasons: Error[] = [];

	onMessagesUpsert(listener: (upsert: MessagesUpsert) => void): void {
		this.listener = listener;
	}

	emitMessages(messages: WAMessage[], type: MessagesUpsert["type"] = "notify"): void {
		this.listener?.({ messages, type });
	}

	end(error: Error): void {
		this.endReasons.push(error);
	}
}

function message(id: string, remoteJid = "15551112222@s.whatsapp.net"): WAMessage {
	return {
		key: { id, remoteJid, fromMe: false },
		message: { conversation: `message ${id}` },
	};
}

function spoolDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "clawdi-wa-runtime-spool-"));
	tempDirs.push(directory);
	return directory;
}

function queue(
	directory: string,
	fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
	maxPendingEvents = 10,
): ClawdiCallbackDeliveryQueue {
	return new ClawdiCallbackDeliveryQueue(
		{
			url: "http://clawdi.test/callback",
			token: "ingress-token",
			spoolDir: directory,
			maxPendingEvents,
			maxPendingBytes: 64 * 1024,
			initialBackoffMs: 1,
			maxBackoffMs: 1,
			requestTimeoutMs: 1000,
		},
		pino({ level: "silent" }),
		{ fetch: fetchImpl, sleep: async () => {} },
	);
}

describe("Baileys runtime callback boundary", () => {
	it("reconnects only transient closes with bounded exponential jitter", () => {
		expect(shouldReconnectAfterClose(false, 428)).toBe(true);
		expect(shouldReconnectAfterClose(false, 408)).toBe(true);
		expect(shouldReconnectAfterClose(false, 515)).toBe(true);
		expect(shouldReconnectAfterClose(false, 503)).toBe(true);
		for (const reason of [undefined, 401, 403, 411, 440, 500]) {
			expect(shouldReconnectAfterClose(false, reason)).toBe(false);
		}
		expect(shouldReconnectAfterClose(true, 408)).toBe(false);

		expect(reconnectDelayMs(0, 0)).toBe(1_500);
		expect(reconnectDelayMs(0, 1)).toBe(3_000);
		expect(reconnectDelayMs(1, 1)).toBe(6_000);
		expect(reconnectDelayMs(100, 1)).toBe(60_000);
	});

	it("atomically journals every normalized event in a batched upsert before delivery", async () => {
		let releaseFirst: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const delivered: string[] = [];
		const callbackQueue = queue(spoolDir(), async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as { messageId: string };
			delivered.push(body.messageId);
			if (delivered.length === 1) await blocked;
			return new Response(null, { status: 200 });
		});
		const retryStored: WAMessage[] = [];
		const socket = new FakeBaileysInboundSocket();
		registerBaileysInboundCallbackListener(socket, callbackQueue, {
			isActive: () => true,
			persistRetryMessages: (messages) => retryStored.push(...messages),
			onBackpressure: (error) => socket.end(error),
		});

		socket.emitMessages([message("batch-1"), message("batch-2"), message("batch-3")]);

		expect(socket.endReasons).toHaveLength(0);
		expect(retryStored.map((stored) => stored.key.id)).toEqual(["batch-1", "batch-2", "batch-3"]);
		expect(callbackQueue.pendingCount()).toBe(3);
		releaseFirst?.();
		await callbackQueue.waitForIdle();
		expect(delivered).toEqual(["batch-1", "batch-2", "batch-3"]);
		expect(callbackQueue.pendingCount()).toBe(0);
		expect(await callbackQueue.stop()).toBe(0);
	});

	it("recovers a runtime-level batched upsert after shutdown", async () => {
		const directory = spoolDir();
		const first = queue(directory, async (_url, init) => {
			await new Promise<void>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
			});
			return new Response(null, { status: 200 });
		});
		const socket = new FakeBaileysInboundSocket();
		registerBaileysInboundCallbackListener(socket, first, {
			isActive: () => true,
			onBackpressure: (error) => socket.end(error),
		});
		socket.emitMessages([message("restart-1"), message("restart-2"), message("restart-3")]);
		expect(await first.stop()).toBe(3);

		const delivered: string[] = [];
		const recovered = queue(directory, async (_url, init) => {
			delivered.push((JSON.parse(String(init?.body)) as { messageId: string }).messageId);
			return new Response(null, { status: 200 });
		});
		await recovered.waitForIdle();
		expect(delivered).toEqual(["restart-1", "restart-2", "restart-3"]);
		expect(await recovered.stop()).toBe(0);
	});

	it("fails visibly without partially journaling a batch beyond the hard cap", async () => {
		const callbackQueue = queue(spoolDir(), async () => new Response(null, { status: 200 }), 2);
		const socket = new FakeBaileysInboundSocket();
		registerBaileysInboundCallbackListener(socket, callbackQueue, {
			isActive: () => true,
			onBackpressure: (error) => socket.end(error),
		});

		socket.emitMessages([message("too-many-1"), message("too-many-2"), message("too-many-3")]);

		expect(socket.endReasons).toHaveLength(1);
		expect(callbackQueue.pendingCount()).toBe(0);
		expect(shouldReconnectAfterClose(true, undefined)).toBe(false);
		expect(await callbackQueue.stop()).toBe(0);
	});

	it("does not expose a callback batch when its retry messages were not fully persisted", async () => {
		let callbackRequests = 0;
		const callbackQueue = queue(spoolDir(), async () => {
			callbackRequests += 1;
			return new Response(null, { status: 200 });
		});
		const socket = new FakeBaileysInboundSocket();
		const retryStoreFailures: Error[] = [];
		registerBaileysInboundCallbackListener(socket, callbackQueue, {
			isActive: () => true,
			persistRetryMessages: () => {
				throw new Error("retry store persisted only part of the batch");
			},
			onRetryStoreFailure: (error) => {
				retryStoreFailures.push(error);
				socket.end(error);
			},
			onBackpressure: (error) => socket.end(error),
		});

		socket.emitMessages([message("partial-1"), message("partial-2")]);

		expect(retryStoreFailures).toHaveLength(1);
		expect(socket.endReasons).toHaveLength(1);
		expect(callbackQueue.pendingCount()).toBe(0);
		expect(callbackRequests).toBe(0);
		expect(shouldReconnectAfterClose(true, undefined)).toBe(false);
		expect(await callbackQueue.stop()).toBe(0);
	});

	it("ingests only notify and ignores history, correction, status, and newsletter events", async () => {
		const delivered: string[] = [];
		const callbackQueue = queue(spoolDir(), async (_url, init) => {
			delivered.push((JSON.parse(String(init?.body)) as { messageId: string }).messageId);
			return new Response(null, { status: 200 });
		});
		const socket = new FakeBaileysInboundSocket();
		registerBaileysInboundCallbackListener(socket, callbackQueue, {
			isActive: () => true,
			onBackpressure: (error) => socket.end(error),
		});

		socket.emitMessages([message("history")], "append");
		socket.emitMessages([message("status", "status@broadcast")]);
		socket.emitMessages([message("newsletter", "12345@newsletter")]);
		socket.emitMessages([message("live")]);
		await callbackQueue.waitForIdle();

		expect(delivered).toEqual(["live"]);
		expect(socket.endReasons).toHaveLength(0);
		expect(await callbackQueue.stop()).toBe(0);
	});

	it("builds quoted context only from the exact sidecar-local retry message", async () => {
		const directory = spoolDir();
		const state = new SQLiteBaileysState(directory, {
			maxMessages: 10,
			maxBytes: 64 * 1024,
			ttlSeconds: 3600,
		});
		const accountJid = "15550000000:1@s.whatsapp.net";
		const key = {
			remoteJid: "120363000000000001@g.us",
			id: "group-inbound-1",
			fromMe: false,
			participant: "15551119999@s.whatsapp.net",
		};
		state.storeMessage(accountJid, key, { conversation: "real inbound" });
		const request = {
			jid: key.remoteJid,
			text: "reply",
			messageId: "client-reply-1",
			replyTo: {
				messageId: key.id,
				participantJid: key.participant,
			},
		};

		expect(await resolveQuotedMessage(state, accountJid, request)).toEqual({
			key,
			message: { conversation: "real inbound" },
		});
		await expect(
			resolveQuotedMessage(state, accountJid, {
				...request,
				replyTo: {
					...request.replyTo,
					participantJid: "15551118888@s.whatsapp.net",
				},
			}),
		).rejects.toThrow("not found in the sidecar retry store");
		await expect(
			resolveQuotedMessage(state, "other-account@s.whatsapp.net", request),
		).rejects.toThrow("not found in the sidecar retry store");
		state.close();
	});

	it("preserves the provider message id when outbound retry persistence rejects or throws", () => {
		const sent = message("provider-outbound-1");
		sent.key.fromMe = true;
		const rejected = recordProviderSentMessage(
			{ storeMessage: () => false },
			"15550000000@s.whatsapp.net",
			sent,
		);
		const failed = recordProviderSentMessage(
			{
				storeMessage: () => {
					throw new Error("disk failure");
				},
			},
			"15550000000@s.whatsapp.net",
			sent,
		);

		expect(rejected.messageId).toBe("provider-outbound-1");
		expect(rejected.retryStoreError?.message).toContain("rejected");
		expect(failed.messageId).toBe("provider-outbound-1");
		expect(failed.retryStoreError?.message).toBe("disk failure");
		expect(shouldReconnectAfterClose(true, undefined)).toBe(false);
	});

	it("returns provider success but enters sticky fatal when outbound storage returns false", async () => {
		const runtime = new BaileysSocketRuntime({
			host: "127.0.0.1",
			port: 8787,
			apiToken: "test-token",
			sessionDir: spoolDir(),
			logLevel: "silent",
			messageStore: {
				maxMessages: 10,
				maxBytes: 64 * 1024,
				ttlSeconds: 3600,
			},
		});
		const state = Reflect.get(runtime, "providerState");
		if (!(state instanceof SQLiteBaileysState)) throw new Error("runtime state unavailable");
		Object.defineProperty(state, "storeMessage", { value: () => false });
		const endReasons: Error[] = [];
		const originalText = "  provider accepted\n ";
		Object.defineProperty(runtime, "socket", {
			writable: true,
			value: {
				user: { id: "15550000000:1@s.whatsapp.net" },
				sendMessage: async (_jid: string, content: { text: string }) => {
					expect(content.text).toBe(originalText);
					return {
						key: {
							id: "provider-stored-false-1",
							remoteJid: "15551112222@s.whatsapp.net",
							fromMe: true,
						},
						message: { conversation: originalText },
					};
				},
				end: (error: Error) => endReasons.push(error),
			},
		});
		Object.defineProperty(runtime, "status", { writable: true, value: "connected" });

		const result = await runtime.sendTextMessage({
			jid: "15551112222@s.whatsapp.net",
			text: originalText,
			messageId: "client-stored-false-1",
		});

		expect(result).toEqual({ messageId: "provider-stored-false-1" });
		expect(endReasons).toHaveLength(1);
		expect(runtime.health()).toMatchObject({
			status: "disconnected",
			connected: false,
			lastDisconnectReason: "retry_message_persistence_failed",
		});
		await expect(runtime.start()).rejects.toThrow("requires operator restart");
		await runtime.stop();
	});

	it("passes sidecar text to Baileys without trimming whitespace or newlines", async () => {
		const originalText = "  first line\nsecond line\t ";
		let receivedText: string | undefined;
		const sent = await sendTextThroughSocket(
			{
				sendMessage: async (_jid, content) => {
					receivedText = content.text;
					return message("provider-whitespace-1");
				},
			},
			{
				jid: "15551112222@s.whatsapp.net",
				text: originalText,
				messageId: "client-whitespace-1",
			},
		);

		expect(receivedText).toBe(originalText);
		expect(sent.key.id).toBe("provider-whitespace-1");
	});
});
