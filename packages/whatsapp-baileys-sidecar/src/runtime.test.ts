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
import { SQLiteBaileysState } from "./sqlite-state.js";
import type { SendOperation, SidecarOperation } from "./types.js";

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

	it("does not consume a new operation id while disconnected and safely retries it after connect", async () => {
		await withRuntime(async (config) => {
			const socket = new FakeSocket();
			const runtime = new BaileysSocketRuntime(config, { makeSocket: () => socket });
			await runtime.start();
			const operation = sendOperation();
			await expect(runtime.performOperation(operation, "hash-a")).rejects.toThrow("not connected");
			expect(socket.sent).toHaveLength(0);
			socket.emitConnection({ connection: "open" });
			expect(await runtime.performOperation(operation, "hash-a")).toEqual({
				operationId: "op-1",
				status: "completed",
				messageId: "BACKEND-M1",
			});
			expect(socket.sent).toHaveLength(1);
			await runtime.stop();
		});
	});

	it("maps the complete typed operation surface to exact public Baileys calls", async () => {
		await withRuntime(async (config) => {
			const socket = new FakeSocket();
			const runtime = new BaileysSocketRuntime(config, { makeSocket: () => socket });
			await runtime.start();
			socket.emitConnection({ connection: "open" });
			const groupJid = "120363000000001@g.us";
			const participantJid = "15550001111@s.whatsapp.net";
			socket.emitMessages({
				type: "notify",
				messages: [
					{
						key: {
							remoteJid: groupJid,
							id: "PEER-1",
							fromMe: false,
							participant: participantJid,
						},
						message: { conversation: "peer message" },
					},
				],
			});

			const operations: SidecarOperation[] = [
				{
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: "op-owned-send",
					chatJid: groupJid,
					type: "send",
					messageId: "OWNED-1",
					content: { type: "text", text: "owned message" },
				},
				{
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: "op-reply",
					chatJid: groupJid,
					type: "send",
					messageId: "REPLY-1",
					content: { type: "text", text: "reply" },
					replyTo: {
						messageId: "PEER-1",
						fromMe: false,
						participantJid,
					},
				},
				{
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: "op-edit",
					chatJid: groupJid,
					type: "edit",
					messageId: "EDIT-1",
					target: { messageId: "OWNED-1", fromMe: true },
					text: "edited",
				},
				{
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: "op-delete",
					chatJid: groupJid,
					type: "delete",
					messageId: "DELETE-1",
					target: { messageId: "OWNED-1", fromMe: true },
				},
				{
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: "op-reaction",
					chatJid: groupJid,
					type: "reaction",
					messageId: "REACTION-1",
					target: {
						messageId: "PEER-1",
						fromMe: false,
						participantJid,
					},
					reaction: "👍",
				},
				{
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: "op-media",
					chatJid: groupJid,
					type: "send",
					messageId: "MEDIA-OUT-1",
					content: {
						type: "media",
						mediaType: "document",
						dataBase64: Buffer.from("file content").toString("base64"),
						mimeType: "text/plain",
						fileName: "note.txt",
						caption: "attached",
					},
				},
				{
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: "op-presence",
					chatJid: groupJid,
					type: "presence",
					presence: "composing",
				},
				{
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: "op-read",
					chatJid: groupJid,
					type: "read",
					messages: [
						{
							messageId: "PEER-1",
							fromMe: false,
							participantJid,
						},
					],
				},
			];
			for (const operation of operations) {
				expect(
					(await runtime.performOperation(operation, `hash-${operation.operationId}`)).status,
				).toBe("completed");
			}

			expect(socket.sent).toHaveLength(6);
			expect(socket.sent[1]?.options?.quoted?.key).toMatchObject({
				remoteJid: groupJid,
				id: "PEER-1",
				fromMe: false,
				participant: participantJid,
			});
			expect(socket.sent[2]?.content).toMatchObject({
				text: "edited",
				edit: { remoteJid: groupJid, id: "OWNED-1", fromMe: true },
			});
			expect(socket.sent[3]?.content).toMatchObject({
				delete: { remoteJid: groupJid, id: "OWNED-1", fromMe: true },
			});
			expect(socket.sent[4]?.content).toMatchObject({
				react: {
					key: {
						remoteJid: groupJid,
						id: "PEER-1",
						fromMe: false,
						participant: participantJid,
					},
					text: "👍",
				},
			});
			expect(socket.sent[5]?.content).toMatchObject({
				document: Buffer.from("file content"),
				mimetype: "text/plain",
				fileName: "note.txt",
				caption: "attached",
			});
			expect(socket.presences).toEqual([{ type: "composing", jid: groupJid }]);
			expect(socket.reads).toEqual([
				[
					{
						remoteJid: groupJid,
						id: "PEER-1",
						fromMe: false,
						participant: participantJid,
					},
				],
			]);
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

	it("detaches a closed socket so its late credentials, messages, and close cannot affect the new owner", async () => {
		await withRuntime(async (config) => {
			const sockets: FakeSocket[] = [];
			const socketConfigs: UserFacingSocketConfig[] = [];
			const runtime = new BaileysSocketRuntime(config, {
				makeSocket: (socketConfig) => {
					socketConfigs.push(socketConfig);
					const socket = new FakeSocket();
					sockets.push(socket);
					return socket;
				},
				setTimer: (callback) => setTimeout(callback, 0),
			});
			await runtime.start();
			const firstSocket = sockets[0];
			const firstConfig = socketConfigs[0];
			if (!firstSocket || !firstConfig) throw new Error("first socket fixture was not created");
			firstConfig.auth.creds.routingInfo = Buffer.from([1]);
			firstSocket.emitCreds();
			await Bun.sleep(0);
			firstSocket.emitConnection({ connection: "open" });
			firstSocket.emitConnection({
				connection: "close",
				lastDisconnect: providerError(408),
			});
			expect(firstSocket.listenerCount()).toBe(0);
			await Bun.sleep(5);
			const secondSocket = sockets[1];
			if (!secondSocket) throw new Error("reconnect socket fixture was not created");
			secondSocket.emitConnection({ connection: "open" });

			firstConfig.auth.creds.routingInfo = Buffer.from([9]);
			firstSocket.emitCreds();
			const staleMessage: WAMessage = {
				key: {
					remoteJid: "15550001111@s.whatsapp.net",
					id: "STALE-1",
					fromMe: false,
				},
				message: { conversation: "stale" },
			};
			firstSocket.emitMessages({ type: "append", messages: [staleMessage] });
			firstSocket.emitConnection({
				connection: "close",
				lastDisconnect: providerError(401),
			});
			expect(runtime.health().status).toBe("connected");
			expect(sockets).toHaveLength(2);
			await runtime.stop();

			const reopened = new SQLiteBaileysState(
				config.accountId,
				config.sessionDir,
				config.messageStore,
			);
			expect(reopened.state.creds.routingInfo).toEqual(Buffer.from([1]));
			expect(await reopened.getMessage(staleMessage.key)).toBeUndefined();
			reopened.close();
		});
	});

	it("captures QR only after explicit QR pairing and keeps pairing secrets out of health", async () => {
		await withRuntime(async (config) => {
			const sockets: FakeSocket[] = [];
			const runtime = new BaileysSocketRuntime(config, {
				makeSocket: () => {
					const socket = new FakeSocket();
					sockets.push(socket);
					return socket;
				},
			});
			await runtime.start();
			const startupSocket = sockets[0];
			if (!startupSocket) throw new Error("startup socket fixture was not created");
			startupSocket.emitConnection({ qr: "UNSOLICITED-QR" });
			expect(runtime.pairingStatus().qr).toBeUndefined();
			expect(runtime.pairingStatus().method).toBeUndefined();

			await runtime.startQrPairing();
			const pairingSocket = sockets[1];
			if (!pairingSocket) throw new Error("pairing socket fixture was not created");
			pairingSocket.emitConnection({ qr: "QR-SECRET" });
			expect(runtime.pairingStatus().qr).toBe("QR-SECRET");
			expect(JSON.stringify(runtime.health())).not.toContain("QR-SECRET");
			const code = await runtime.startCodePairing("15550001111");
			expect(code.code).toBe("CODE-SECRET");
			expect(JSON.stringify(runtime.health())).not.toContain("CODE-SECRET");
			await runtime.stop();
		});
	});

	it("refuses logout without a connected current socket and preserves local auth", async () => {
		await withRuntime(async (config) => {
			const socket = new FakeSocket();
			const runtime = new BaileysSocketRuntime(config, {
				makeSocket: (socketConfig) => {
					socketConfig.auth.creds.registered = true;
					return socket;
				},
			});
			await runtime.start();
			socket.emitCreds();
			await Bun.sleep(0);
			await expect(runtime.logout()).rejects.toThrow("not connected");
			expect(socket.logoutCount).toBe(0);
			expect(runtime.health().registered).toBe(true);
			await runtime.stop();

			const reopened = new SQLiteBaileysState(
				config.accountId,
				config.sessionDir,
				config.messageStore,
			);
			expect(reopened.state.creds.registered).toBe(true);
			reopened.close();
		});
	});

	it("fail-stops and preserves complete local auth when provider logout fails", async () => {
		await withRuntime(async (config) => {
			const socket = new FakeSocket();
			socket.logoutError = new Error("fixture provider failure");
			let authState: UserFacingSocketConfig["auth"] | undefined;
			const runtime = new BaileysSocketRuntime(config, {
				makeSocket: (socketConfig) => {
					authState = socketConfig.auth;
					socketConfig.auth.creds.registered = true;
					return socket;
				},
			});
			await runtime.start();
			if (!authState) throw new Error("auth state fixture was not captured");
			await authState.keys.set({ session: { "fixture-session": Buffer.from([4, 5]) } });
			socket.emitCreds();
			await Bun.sleep(0);
			socket.emitConnection({ connection: "open" });
			await expect(runtime.logout()).rejects.toThrow("linked auth was preserved");
			expect(socket.logoutCount).toBe(1);
			expect(runtime.health()).toMatchObject({
				status: "fatal",
				fatalReason: "logout_failed",
				registered: true,
			});
			await runtime.stop();

			const reopened = new SQLiteBaileysState(
				config.accountId,
				config.sessionDir,
				config.messageStore,
			);
			expect(reopened.state.creds.registered).toBe(true);
			expect(
				(await reopened.state.keys.get("session", ["fixture-session"]))["fixture-session"],
			).toEqual(Buffer.from([4, 5]));
			reopened.close();
		});
	});

	it("clears linked credentials and Signal state only after provider logout succeeds", async () => {
		await withRuntime(async (config) => {
			const socket = new FakeSocket();
			let authState: UserFacingSocketConfig["auth"] | undefined;
			const runtime = new BaileysSocketRuntime(config, {
				makeSocket: (socketConfig) => {
					authState = socketConfig.auth;
					socketConfig.auth.creds.registered = true;
					return socket;
				},
			});
			await runtime.start();
			if (!authState) throw new Error("auth state fixture was not captured");
			await authState.keys.set({ session: { "fixture-session": Buffer.from([4, 5]) } });
			socket.emitCreds();
			await Bun.sleep(0);
			socket.emitConnection({ connection: "open" });
			await runtime.logout();
			expect(socket.logoutCount).toBe(1);
			expect(runtime.health()).toMatchObject({ status: "stopped", registered: false });
			await runtime.stop();

			const reopened = new SQLiteBaileysState(
				config.accountId,
				config.sessionDir,
				config.messageStore,
			);
			expect(reopened.state.creds.registered).toBe(false);
			expect(
				(await reopened.state.keys.get("session", ["fixture-session"]))["fixture-session"],
			).toBeUndefined();
			reopened.close();
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
	readonly reads: WAMessageKey[][] = [];
	readonly presences: Array<{ type: WAPresence; jid?: string }> = [];
	logoutCount = 0;
	logoutError: Error | undefined;

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

	async readMessages(keys: WAMessageKey[]): Promise<void> {
		this.reads.push(keys);
	}
	async sendPresenceUpdate(type: WAPresence, jid?: string): Promise<void> {
		this.presences.push({ type, ...(jid ? { jid } : {}) });
	}
	async requestPairingCode(_phoneNumber: string): Promise<string> {
		return "CODE-SECRET";
	}
	async logout(): Promise<void> {
		this.logoutCount += 1;
		if (this.logoutError) throw this.logoutError;
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

	emitCreds(): void {
		for (const listener of this.credsListeners) listener();
	}

	emitMessages(upsert: { messages: WAMessage[]; type: "append" | "notify" }): void {
		for (const listener of this.messageListeners) listener(upsert);
	}

	listenerCount(): number {
		return (
			this.credsListeners.length + this.connectionListeners.length + this.messageListeners.length
		);
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
