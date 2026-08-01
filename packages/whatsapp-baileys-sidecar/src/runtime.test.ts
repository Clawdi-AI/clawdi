import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	AnyMessageContent,
	MiscMessageGenerationOptions,
	UserFacingSocketConfig,
	WAMessage,
	WAMessageKey,
	WAPresence,
} from "baileys";

import type { SidecarConfig } from "./config.js";
import { normalizeInboundMessage } from "./normalize.js";
import {
	BaileysSocketRuntime,
	reconnectDelayMs,
	type SocketLike,
	shouldReconnectAfterClose,
} from "./runtime.js";
import type { SendOperation } from "./types.js";

describe("single-socket runtime", () => {
	it("uses the persisted fixed advertised version and never creates overlapping sockets", async () => {
		await withRuntime(async (config) => {
			const sockets: FakeSocket[] = [];
			const versions: UserFacingSocketConfig["version"][] = [];
			const runtime = new BaileysSocketRuntime(config, {
				makeSocket: (socketConfig) => {
					versions.push(socketConfig.version);
					const socket = new FakeSocket();
					sockets.push(socket);
					return socket;
				},
			});
			await runtime.start();
			await runtime.start();
			expect(sockets).toHaveLength(1);
			expect(versions).toEqual([[2, 3000, 1035194821]]);
			expect(runtime.health().advertisedRelease).toMatchObject({
				packageVersion: "7.0.0-rc13",
				sourceCommit: "8053b086ecc97ec3f78299561de11959bab05d39",
			});
			await runtime.stop();
		});
	});

	it("passes the stable backend message id and returns the durable idempotent result once", async () => {
		await withRuntime(async (config) => {
			const socket = new FakeSocket();
			const runtime = new BaileysSocketRuntime(config, { makeSocket: () => socket });
			await runtime.start();
			socket.emitConnection({ connection: "open" });
			const operation = sendOperation();
			const first = await runtime.performOperation(operation, "hash-a");
			const repeated = await runtime.performOperation(operation, "hash-a");
			expect(first).toEqual({ operationId: "op-1", status: "completed", messageId: "BACKEND-M1" });
			expect(repeated).toEqual(first);
			expect(socket.sent).toHaveLength(1);
			expect(socket.sent[0]?.options?.messageId).toBe("BACKEND-M1");
			await expect(runtime.performOperation(operation, "hash-b")).rejects.toThrow(
				"different request",
			);
			await runtime.stop();
		});
	});

	it("reconnects only transient closures and fail-stops logged-out/non-transient closures", async () => {
		expect(shouldReconnectAfterClose(false, 408)).toBe(true);
		expect(shouldReconnectAfterClose(false, 515)).toBe(true);
		expect(shouldReconnectAfterClose(false, 401)).toBe(false);
		expect(shouldReconnectAfterClose(false, undefined)).toBe(false);
		expect(shouldReconnectAfterClose(true, 408)).toBe(false);
		expect(reconnectDelayMs(0, 0)).toBe(500);
		expect(reconnectDelayMs(1, 1)).toBe(2000);

		await withRuntime(async (config) => {
			const sockets: FakeSocket[] = [];
			const runtime = new BaileysSocketRuntime(config, {
				makeSocket: () => {
					const socket = new FakeSocket();
					sockets.push(socket);
					return socket;
				},
				setTimer: (callback) => setTimeout(callback, 0),
			});
			await runtime.start();
			sockets[0]?.emitConnection({ connection: "close", lastDisconnect: providerError(408) });
			await Bun.sleep(5);
			expect(sockets).toHaveLength(2);
			sockets[1]?.emitConnection({ connection: "close", lastDisconnect: providerError(401) });
			expect(runtime.health().status).toBe("fatal");
			expect(runtime.health().fatalReason).toBe("logged_out");
			await runtime.stop();
		});
	});

	it("keeps pairing secrets out of health and clears linked auth on deliberate logout", async () => {
		await withRuntime(async (config) => {
			const socket = new FakeSocket();
			const runtime = new BaileysSocketRuntime(config, { makeSocket: () => socket });
			await runtime.start();
			socket.emitConnection({ qr: "QR-SECRET" });
			expect(runtime.pairingStatus().qr).toBe("QR-SECRET");
			expect(JSON.stringify(runtime.health())).not.toContain("QR-SECRET");
			const code = await runtime.startCodePairing("15550001111");
			expect(code.code).toBe("CODE-SECRET");
			expect(JSON.stringify(runtime.health())).not.toContain("CODE-SECRET");
			socket.emitConnection({ connection: "open" });
			await runtime.logout();
			expect(socket.logoutCount).toBe(1);
			expect(runtime.health().registered).toBe(false);
			expect(runtime.health().status).toBe("stopped");
			await runtime.stop();
		});
	});

	it("bounds public media downloads from previously persisted inbound messages", async () => {
		await withRuntime(async (config) => {
			config.mediaMaxBytes = 3;
			const socket = new FakeSocket();
			const inbound = mediaMessage();
			const event = normalizeInboundMessage(inbound, config.accountId);
			if (event?.content.type !== "media") throw new Error("media fixture did not normalize");
			const runtime = new BaileysSocketRuntime(config, {
				makeSocket: () => socket,
				downloadMedia: async () => chunks(Buffer.from([1, 2]), Buffer.from([3, 4])),
			});
			await runtime.start();
			socket.emitConnection({ connection: "open" });
			socket.emitMessages({ type: "notify", messages: [inbound] });
			await expect(runtime.downloadMedia(event.content.mediaId)).rejects.toThrow("byte limit");
			await runtime.stop();
		});
	});

	it("fail-stops the socket when durable operation persistence fails", async () => {
		await withRuntime(async (config) => {
			config.messageStore.maxBytes = 1;
			const socket = new FakeSocket();
			const runtime = new BaileysSocketRuntime(config, { makeSocket: () => socket });
			await runtime.start();
			socket.emitConnection({ connection: "open" });
			await expect(runtime.performOperation(sendOperation(), "hash-a")).rejects.toThrow(
				"persistent sidecar state failed",
			);
			expect(runtime.health().status).toBe("fatal");
			expect(runtime.health().fatalReason).toBe("persistent_state_failure");
			await runtime.stop();
		});
	});

	it("requires explicit recovery acceptance for persisted release changes without wiping auth", async () => {
		await withRuntime(async (config) => {
			const initial = new BaileysSocketRuntime(config, { makeSocket: () => new FakeSocket() });
			await initial.stop();
			const db = new Database(join(config.sessionDir, "baileys-state.sqlite"));
			db.query("UPDATE metadata SET value = ? WHERE key = 'baileys_release'").run(
				JSON.stringify({
					packageName: "@whiskeysockets/baileys",
					packageVersion: "7.0.0-previous",
					sourceCommit: "previous",
					version: [2, 2999, 1],
				}),
			);
			db.close();
			const sockets: FakeSocket[] = [];
			const recovered = new BaileysSocketRuntime(config, {
				makeSocket: () => {
					const socket = new FakeSocket();
					sockets.push(socket);
					return socket;
				},
			});
			expect(recovered.health().advertisedRelease.version).toEqual([2, 2999, 1]);
			await expect(recovered.start()).rejects.toThrow("explicit recovery acceptance");
			await expect(recovered.recover(false)).rejects.toThrow("explicit recovery acceptance");
			await recovered.recover(true);
			expect(sockets).toHaveLength(1);
			expect(recovered.health().advertisedRelease.version).toEqual([2, 3000, 1035194821]);
			await recovered.stop();
		});
	});
});

class FakeSocket implements SocketLike {
	private credsListeners: Array<() => void> = [];
	private connectionListeners: Array<
		(update: {
			connection?: "open" | "connecting" | "close";
			lastDisconnect?: { error?: Error };
			qr?: string;
		}) => void
	> = [];
	private messageListeners: Array<
		(upsert: { messages: WAMessage[]; type: "append" | "notify"; requestId?: string }) => void
	> = [];
	readonly user = { id: "15559990000@s.whatsapp.net", lid: "999999999@lid", name: "test" };
	readonly sent: Array<{
		jid: string;
		content: AnyMessageContent;
		options?: MiscMessageGenerationOptions;
	}> = [];
	logoutCount = 0;

	readonly ev = {
		on: ((event: string, listener: (...args: never[]) => void) => {
			if (event === "creds.update") this.credsListeners.push(listener);
			if (event === "connection.update") {
				this.connectionListeners.push(
					listener as (update: Parameters<FakeSocket["emitConnection"]>[0]) => void,
				);
			}
			if (event === "messages.upsert") {
				this.messageListeners.push(
					listener as (upsert: Parameters<FakeSocket["emitMessages"]>[0]) => void,
				);
			}
		}) as SocketLike["ev"]["on"],
		removeAllListeners: ((event: string) => {
			if (event === "creds.update") this.credsListeners = [];
			if (event === "connection.update") this.connectionListeners = [];
			if (event === "messages.upsert") this.messageListeners = [];
		}) as SocketLike["ev"]["removeAllListeners"],
	};

	async sendMessage(
		jid: string,
		content: AnyMessageContent,
		options?: MiscMessageGenerationOptions,
	): Promise<WAMessage> {
		this.sent.push({ jid, content, options });
		return {
			key: { remoteJid: jid, id: options?.messageId ?? "generated", fromMe: true },
			message: "text" in content ? { conversation: content.text } : { conversation: "mutation" },
		};
	}

	async readMessages(_keys: WAMessageKey[]): Promise<void> {}
	async sendPresenceUpdate(_type: WAPresence, _jid?: string): Promise<void> {}
	async requestPairingCode(_phoneNumber: string): Promise<string> {
		return "CODE-SECRET";
	}
	async logout(): Promise<void> {
		this.logoutCount += 1;
	}
	end(_error?: Error): void {}
	async updateMediaMessage(message: WAMessage): Promise<WAMessage> {
		return message;
	}

	emitConnection(update: {
		connection?: "open" | "connecting" | "close";
		lastDisconnect?: { error?: Error };
		qr?: string;
	}): void {
		for (const listener of this.connectionListeners) listener(update);
	}

	emitMessages(upsert: { messages: WAMessage[]; type: "append" | "notify" }): void {
		for (const listener of this.messageListeners) listener(upsert);
	}
}

function sendOperation(): SendOperation {
	return {
		schemaVersion: "clawdi.whatsapp.operation.v1",
		operationId: "op-1",
		chatJid: "15550001111@s.whatsapp.net",
		type: "send",
		messageId: "BACKEND-M1",
		content: { type: "text", text: "hello" },
	};
}

function mediaMessage(): WAMessage {
	return {
		key: { remoteJid: "15550001111@s.whatsapp.net", id: "MEDIA-1", fromMe: false },
		message: {
			imageMessage: {
				mediaKey: Buffer.from([1, 2, 3]),
				directPath: "/media",
				mimetype: "image/jpeg",
				fileLength: 4,
			},
		},
	};
}

function providerError(statusCode: number): { error: Error } {
	return { error: Object.assign(new Error("provider close"), { output: { statusCode } }) };
}

async function* chunks(...values: Buffer[]): AsyncIterable<Uint8Array> {
	for (const value of values) yield value;
}

async function withRuntime(run: (config: SidecarConfig) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "clawdi-wa-runtime-"));
	const sessionDir = join(root, "session");
	mkdirSync(sessionDir, { mode: 0o700 });
	const config: SidecarConfig = {
		host: "127.0.0.1",
		port: 8787,
		apiToken: "sidecar-token",
		accountId: "account-a",
		sessionDir,
		logLevel: "silent",
		messageStore: { maxMessages: 100, maxBytes: 1024 * 1024, ttlSeconds: 3600 },
		mediaMaxBytes: 1024,
	};
	try {
		await run(config);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
