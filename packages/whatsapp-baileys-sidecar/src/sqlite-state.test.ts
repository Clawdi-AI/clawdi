import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proto } from "baileys";

import { SQLiteBaileysState } from "./sqlite-state.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sessionDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "clawdi-wa-state-"));
	tempDirs.push(directory);
	return directory;
}

const messageStore = {
	maxMessages: 2,
	maxBytes: 64 * 1024,
	ttlSeconds: 3600,
};

describe("SQLite Baileys state", () => {
	it("persists BufferJSON auth creds and Signal keys across restart", async () => {
		const directory = sessionDir();
		const first = new SQLiteBaileysState(directory, messageStore);
		first.state.creds.registered = true;
		first.state.creds.routingInfo = Buffer.from([1, 2, 3]);
		await first.state.keys.set({
			"pre-key": {
				"pre-key-1": {
					public: Uint8Array.from([4, 5]),
					private: Uint8Array.from([6, 7]),
				},
			},
		});
		await first.saveCreds();
		first.close();

		const recovered = new SQLiteBaileysState(directory, messageStore);
		const keys = await recovered.state.keys.get("pre-key", ["pre-key-1"]);
		expect(recovered.state.creds.registered).toBe(true);
		expect(recovered.state.creds.routingInfo).toEqual(Buffer.from([1, 2, 3]));
		expect(keys["pre-key-1"]?.public).toEqual(Uint8Array.from([4, 5]));
		expect(keys["pre-key-1"]?.private).toEqual(Uint8Array.from([6, 7]));
		recovered.close();
	});

	it("rolls back a multi-key update atomically on SQLite failure", async () => {
		const directory = sessionDir();
		new SQLiteBaileysState(directory, messageStore).close();
		const inspector = new Database(join(directory, "baileys-state.sqlite"));
		inspector.exec(`
			CREATE TRIGGER reject_bad_signal_key
			BEFORE INSERT ON signal_keys
			WHEN NEW.key_id = 'bad'
			BEGIN
				SELECT RAISE(ABORT, 'forced transaction failure');
			END;
		`);
		inspector.close();
		const state = new SQLiteBaileysState(directory, messageStore);

		await expect(
			state.state.keys.set({
				"pre-key": {
					good: {
						public: Uint8Array.from([1]),
						private: Uint8Array.from([2]),
					},
				},
				session: { bad: Uint8Array.from([3]) },
			}),
		).rejects.toThrow("forced transaction failure");
		const keys = await state.state.keys.get("pre-key", ["good"]);
		expect(keys.good).toBeUndefined();

		state.close();
	});

	it("fails closed on legacy multi-file auth instead of silently replacing identity", () => {
		const directory = sessionDir();
		writeFileSync(join(directory, "creds.json"), "{}");

		expect(() => new SQLiteBaileysState(directory, messageStore)).toThrow(
			"requires explicit migration",
		);
		expect(() => statSync(join(directory, "baileys-state.sqlite"))).toThrow();
	});

	it("holds an exclusive session lease and protects state file permissions", () => {
		const directory = sessionDir();
		const first = new SQLiteBaileysState(directory, messageStore);
		expect(statSync(join(directory, "baileys-state.sqlite")).mode & 0o777).toBe(0o600);
		expect(() => new SQLiteBaileysState(directory, messageStore)).toThrow("database is locked");
		first.close();

		const recovered = new SQLiteBaileysState(directory, messageStore);
		recovered.close();
	});

	it("recovers callback handoff intent with the exact retry message", async () => {
		const directory = sessionDir();
		const accountJid = "15550000000:1@s.whatsapp.net";
		const key = {
			remoteJid: "15551110001@s.whatsapp.net",
			id: "inbound-durable-1",
			fromMe: false,
		};
		const event = {
			schemaVersion: "clawdi.whatsapp.sidecar-event.v1" as const,
			providerEventId: `message:${"a".repeat(64)}`,
			messageId: "inbound-durable-1",
			chatJid: key.remoteJid,
			actorJid: key.remoteJid,
			fromMe: false as const,
			text: "durable inbound",
		};
		const first = new SQLiteBaileysState(directory, messageStore);
		expect(
			first.storeInboundBatch(accountJid, [
				{ event, message: { key, message: { conversation: "durable inbound" } } },
			]),
		).toBe(1);
		first.close();

		const recovered = new SQLiteBaileysState(directory, messageStore);
		expect(recovered.pendingInboundEvents()).toEqual([event]);
		expect(await recovered.getMessage(accountJid, key)).toEqual({
			conversation: "durable inbound",
		});
		recovered.markInboundEventsHandedOff([event.providerEventId]);
		expect(recovered.pendingInboundEvents()).toEqual([]);
		recovered.close();
	});

	it("rejects an oversized retry-message batch without partially persisting it", async () => {
		const directory = sessionDir();
		const state = new SQLiteBaileysState(directory, {
			maxMessages: 10,
			maxBytes: 24,
			ttlSeconds: 3600,
		});
		const accountJid = "15550000000:1@s.whatsapp.net";
		const firstKey = {
			remoteJid: "15551110001@s.whatsapp.net",
			id: "batch-small",
			fromMe: false,
		};
		const oversizedKey = { ...firstKey, id: "batch-oversized" };

		expect(() =>
			state.storeMessages(accountJid, [
				{ key: firstKey, message: { conversation: "ok" } },
				{ key: oversizedKey, message: { conversation: "x".repeat(100) } },
			]),
		).toThrow("above the byte cap");
		expect(await state.getMessage(accountJid, firstKey)).toBeUndefined();
		expect(await state.getMessage(accountJid, oversizedKey)).toBeUndefined();
		state.close();
	});

	it("rejects aggregate batch overflow and never evicts a newly accepted batch member", async () => {
		const directory = sessionDir();
		const content = { conversation: "batch member" };
		const encodedBytes = proto.Message.encode(content).finish().byteLength;
		const accountJid = "15550000000:1@s.whatsapp.net";
		const baseKey = {
			remoteJid: "15551110001@s.whatsapp.net",
			fromMe: false,
		};
		const byteLimited = new SQLiteBaileysState(directory, {
			maxMessages: 10,
			maxBytes: encodedBytes * 2 - 1,
			ttlSeconds: 3600,
		});
		expect(() =>
			byteLimited.storeMessages(accountJid, [
				{ key: { ...baseKey, id: "bytes-1" }, message: content },
				{ key: { ...baseKey, id: "bytes-2" }, message: content },
			]),
		).toThrow("aggregate byte cap");
		expect(await byteLimited.getMessage(accountJid, { ...baseKey, id: "bytes-1" })).toBeUndefined();
		byteLimited.close();

		const countDirectory = sessionDir();
		const countLimited = new SQLiteBaileysState(countDirectory, {
			maxMessages: 2,
			maxBytes: 64 * 1024,
			ttlSeconds: 3600,
		});
		countLimited.storeMessage(accountJid, { ...baseKey, id: "old" }, { conversation: "old" });
		expect(
			countLimited.storeMessages(accountJid, [
				{ key: { ...baseKey, id: "new-1" }, message: content },
				{ key: { ...baseKey, id: "new-2" }, message: content },
			]),
		).toBe(2);
		expect(await countLimited.getMessage(accountJid, { ...baseKey, id: "old" })).toBeUndefined();
		expect(await countLimited.getMessage(accountJid, { ...baseKey, id: "new-1" })).toEqual(content);
		expect(await countLimited.getMessage(accountJid, { ...baseKey, id: "new-2" })).toEqual(content);
		expect(() =>
			countLimited.storeMessages(accountJid, [
				{ key: { ...baseKey, id: "too-many-1" }, message: content },
				{ key: { ...baseKey, id: "too-many-2" }, message: content },
				{ key: { ...baseKey, id: "too-many-3" }, message: content },
			]),
		).toThrow("message count cap");
		countLimited.close();
	});

	it("stores bounded retry messages by full key and never fabricates a miss", async () => {
		const directory = sessionDir();
		const first = new SQLiteBaileysState(directory, messageStore);
		const accountJid = "15550000000:1@s.whatsapp.net";
		const firstKey = {
			remoteJid: "15551110001@s.whatsapp.net",
			id: "client-message-1",
			fromMe: true,
		};
		expect(await first.storeMessage(accountJid, firstKey, { conversation: "first" })).toBe(true);
		first.close();

		const recovered = new SQLiteBaileysState(directory, messageStore);
		expect(await recovered.getMessage(accountJid, firstKey)).toEqual({
			conversation: "first",
		});
		expect(await recovered.getMessage(accountJid, { ...firstKey, id: "missing" })).toBeUndefined();
		expect(await recovered.getMessage("other-account@s.whatsapp.net", firstKey)).toBeUndefined();
		const groupKey = {
			remoteJid: "120363000000000001@g.us",
			id: "group-inbound-1",
			fromMe: false,
			participant: "15551119999@s.whatsapp.net",
		};
		recovered.storeMessage(accountJid, groupKey, { conversation: "group inbound" });
		expect(await recovered.getMessage(accountJid, groupKey)).toEqual({
			conversation: "group inbound",
		});
		expect(
			await recovered.getMessage(accountJid, {
				...groupKey,
				participant: "15551118888@s.whatsapp.net",
			}),
		).toBeUndefined();
		expect(
			await recovered.getMessage(accountJid, {
				...groupKey,
				remoteJid: "120363000000000002@g.us",
			}),
		).toBeUndefined();
		const outboundKey = {
			remoteJid: "15551110002@s.whatsapp.net",
			id: "client-outbound-1",
			fromMe: true,
		};
		recovered.storeMessage(accountJid, outboundKey, { conversation: "outbound" });
		expect(await recovered.getMessage(accountJid, outboundKey)).toEqual({
			conversation: "outbound",
		});
		expect(
			await recovered.getMessage(accountJid, { ...outboundKey, fromMe: false }),
		).toBeUndefined();

		await recovered.storeMessage(
			accountJid,
			{ ...firstKey, id: "client-message-2" },
			{ conversation: "second" },
		);
		await recovered.storeMessage(
			accountJid,
			{ ...firstKey, id: "client-message-3" },
			{ conversation: "third" },
		);
		expect(await recovered.getMessage(accountJid, firstKey)).toBeUndefined();
		expect(await recovered.getMessage(accountJid, { ...firstKey, id: "client-message-2" })).toEqual(
			{ conversation: "second" },
		);
		expect(await recovered.getMessage(accountJid, { ...firstKey, id: "client-message-3" })).toEqual(
			{ conversation: "third" },
		);
		recovered.close();
	});
});
