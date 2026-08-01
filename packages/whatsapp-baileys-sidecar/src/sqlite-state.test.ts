import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proto, type WAMessage } from "baileys";

import { SQLITE_SCHEMA_VERSION, SQLiteBaileysState } from "./sqlite-state.js";

const STORE_CONFIG = { maxMessages: 100, maxBytes: 1024 * 1024, ttlSeconds: 3600 };

describe("SQLite Baileys state", () => {
	it("round-trips full credentials and every representative Signal shape including app-state bytes", async () => {
		usingTempDir(async (dir) => {
			const first = new SQLiteBaileysState("account-a", dir, STORE_CONFIG);
			first.state.creds.registered = true;
			first.state.creds.routingInfo = Buffer.from([1, 2, 3]);
			first.state.creds.additionalData = { nested: Buffer.from([4, 5]) };
			await first.state.keys.set({
				"pre-key": { p1: { public: Buffer.from([1]), private: Buffer.from([2]) } },
				session: { s1: Buffer.from([3, 4]) },
				"sender-key": { k1: Buffer.from([5, 6]) },
				"sender-key-memory": { m1: { "1@s.whatsapp.net": true } },
				"app-state-sync-key": {
					a1: proto.Message.AppStateSyncKeyData.create({
						keyData: Buffer.from([7, 8, 9]),
						fingerprint: { rawId: 4, currentIndex: 2, deviceIndexes: [1, 3] },
						timestamp: 123,
					}),
				},
				"app-state-sync-version": {
					v1: { version: 2, hash: Buffer.from([10]), indexValueMap: {} },
				},
				"lid-mapping": { l1: "15550001111@s.whatsapp.net" },
				"device-list": { d1: ["1:1@s.whatsapp.net"] },
				tctoken: { t1: { token: Buffer.from([11]), timestamp: "12" } },
				"identity-key": { i1: Buffer.from([12, 13]) },
			});
			await first.saveCreds();
			first.close();

			const reopened = new SQLiteBaileysState("account-a", dir, STORE_CONFIG);
			expect(reopened.state.creds.registered).toBe(true);
			expect(reopened.state.creds.routingInfo).toEqual(Buffer.from([1, 2, 3]));
			expect(reopened.state.creds.additionalData).toEqual({ nested: Buffer.from([4, 5]) });
			const appState = await reopened.state.keys.get("app-state-sync-key", ["a1"]);
			expect(appState.a1).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
			expect(appState.a1?.keyData).toEqual(Buffer.from([7, 8, 9]));
			const session = await reopened.state.keys.get("session", ["s1"]);
			expect(session.s1).toEqual(Buffer.from([3, 4]));
			const preKey = await reopened.state.keys.get("pre-key", ["p1"]);
			expect(preKey.p1).toEqual({ public: Buffer.from([1]), private: Buffer.from([2]) });
			const senderKey = await reopened.state.keys.get("sender-key", ["k1"]);
			expect(senderKey.k1).toEqual(Buffer.from([5, 6]));
			const senderMemory = await reopened.state.keys.get("sender-key-memory", ["m1"]);
			expect(senderMemory.m1).toEqual({ "1@s.whatsapp.net": true });
			const appVersion = await reopened.state.keys.get("app-state-sync-version", ["v1"]);
			expect(appVersion.v1).toEqual({ version: 2, hash: Buffer.from([10]), indexValueMap: {} });
			const lidMapping = await reopened.state.keys.get("lid-mapping", ["l1"]);
			expect(lidMapping.l1).toBe("15550001111@s.whatsapp.net");
			const devices = await reopened.state.keys.get("device-list", ["d1"]);
			expect(devices.d1).toEqual(["1:1@s.whatsapp.net"]);
			const token = await reopened.state.keys.get("tctoken", ["t1"]);
			expect(token.t1?.token).toEqual(Buffer.from([11]));
			const identity = await reopened.state.keys.get("identity-key", ["i1"]);
			expect(identity.i1).toEqual(Buffer.from([12, 13]));
			reopened.close();
		});
	});

	it("owns the database exclusively, rejects account mismatch, legacy JSON, and keeps private modes", async () => {
		usingTempDir(async (dir) => {
			const owner = new SQLiteBaileysState("account-a", dir, STORE_CONFIG);
			expect(() => new SQLiteBaileysState("account-a", dir, STORE_CONFIG)).toThrow();
			expect(statSync(join(dir, "baileys-state.sqlite")).mode & 0o777).toBe(0o600);
			owner.close();
			expect(() => new SQLiteBaileysState("account-b", dir, STORE_CONFIG)).toThrow(
				"account mismatch",
			);
		});
		usingTempDir(async (dir) => {
			writeFileSync(join(dir, "creds.json"), "{}", { mode: 0o600 });
			expect(() => new SQLiteBaileysState("account-a", dir, STORE_CONFIG)).toThrow(
				"explicit migration",
			);
		});
	});

	it("finds a restart retry when the receipt adds participant", async () => {
		usingTempDir(async (dir) => {
			const outbound = textMessage({
				remoteJid: "15550001111@s.whatsapp.net",
				id: "OUTBOUND-1",
				fromMe: true,
			});
			const first = new SQLiteBaileysState("account-a", dir, STORE_CONFIG);
			first.storeMessage(outbound);
			first.close();
			const reopened = new SQLiteBaileysState("account-a", dir, STORE_CONFIG);
			const retried = await reopened.getMessage({
				remoteJid: "15550001111@s.whatsapp.net",
				id: "OUTBOUND-1",
				fromMe: true,
				participant: "15559990000@s.whatsapp.net",
			});
			expect(retried).toEqual({ conversation: "durable" });
			const aliased = textMessage({
				remoteJid: "15550002222@s.whatsapp.net",
				remoteJidAlt: "123456789@lid",
				id: "ALIASED-1",
				fromMe: false,
			});
			reopened.storeMessage(aliased);
			expect(
				await reopened.getMessage({
					remoteJid: "123456789@lid",
					remoteJidAlt: "15550002222@s.whatsapp.net",
					id: "ALIASED-1",
					fromMe: false,
					participant: "15550003333@s.whatsapp.net",
				}),
			).toEqual({ conversation: "durable" });
			reopened.close();
		});
	});

	it("marks crash-left pending operations ambiguous and preserves completed idempotent results", async () => {
		usingTempDir(async (dir) => {
			const first = new SQLiteBaileysState("account-a", dir, STORE_CONFIG);
			expect(first.reserveOperation("op-1", "hash-a")).toEqual({ action: "execute" });
			first.close();
			const reopened = new SQLiteBaileysState("account-a", dir, STORE_CONFIG);
			expect(reopened.reserveOperation("op-1", "hash-a")).toEqual({
				action: "return",
				result: {
					operationId: "op-1",
					status: "ambiguous",
					error: "operation_ambiguous",
				},
			});
			expect(() => reopened.reserveOperation("op-1", "hash-b")).toThrow("different request");
			expect(reopened.reserveOperation("op-2", "hash-c")).toEqual({ action: "execute" });
			reopened.completeOperation("op-2", "hash-c", {
				operationId: "op-2",
				status: "completed",
				messageId: "M2",
			});
			expect(reopened.reserveOperation("op-2", "hash-c")).toEqual({
				action: "return",
				result: { operationId: "op-2", status: "completed", messageId: "M2" },
			});
			reopened.close();
		});
	});

	it("migrates user_version transactionally and recovers committed WAL state after an abrupt process exit", async () => {
		usingTempDir(async (dir) => {
			createVersionOneDatabase(join(dir, "baileys-state.sqlite"));
			const migrated = new SQLiteBaileysState("account-a", dir, STORE_CONFIG);
			migrated.close();
			const db = new Database(join(dir, "baileys-state.sqlite"));
			expect(
				db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
			).toBe(SQLITE_SCHEMA_VERSION);
			db.close();

			const script = `
				import { SQLiteBaileysState } from "${join(import.meta.dir, "sqlite-state.ts")}";
				const state = new SQLiteBaileysState("account-a", process.argv[1], ${JSON.stringify(STORE_CONFIG)});
				state.state.creds.routingInfo = Buffer.from([91, 92]);
				await state.saveCreds();
				process.exit(0);
			`;
			const child = Bun.spawnSync(["bun", "-e", script, dir], { cwd: process.cwd() });
			if (child.exitCode !== 0) throw new Error(child.stderr.toString());
			const recovered = new SQLiteBaileysState("account-a", dir, STORE_CONFIG);
			expect(recovered.state.creds.routingInfo).toEqual(Buffer.from([91, 92]));
			recovered.close();
		});
	});
});

function textMessage(key: WAMessage["key"]): WAMessage {
	return { key, message: { conversation: "durable" }, messageTimestamp: 1 };
}

async function usingTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "clawdi-wa-state-"));
	const dir = join(root, "session");
	mkdirSync(dir, { mode: 0o700 });
	try {
		await run(dir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function createVersionOneDatabase(path: string): void {
	const db = new Database(path, { create: true });
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE auth_creds (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), value TEXT NOT NULL);
		CREATE TABLE signal_keys (category TEXT NOT NULL, key_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (category, key_id));
		CREATE TABLE stored_messages (identity_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, message_id TEXT NOT NULL, from_me INTEGER NOT NULL, message BLOB NOT NULL, wamessage BLOB NOT NULL, byte_count INTEGER NOT NULL, created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL);
		CREATE TABLE message_aliases (account_id TEXT NOT NULL, chat_alias TEXT NOT NULL, message_id TEXT NOT NULL, from_me INTEGER NOT NULL, identity_id TEXT NOT NULL REFERENCES stored_messages(identity_id) ON DELETE CASCADE, PRIMARY KEY (account_id, chat_alias, message_id, from_me));
		CREATE TABLE pending_callback_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, provider_event_id TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL, created_at INTEGER NOT NULL);
		CREATE INDEX stored_messages_age ON stored_messages(accessed_at, created_at);
		PRAGMA user_version = 1;
	`);
	db.close();
}
