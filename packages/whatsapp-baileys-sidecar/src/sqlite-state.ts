import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
	type AuthenticationCreds,
	type AuthenticationState,
	BufferJSON,
	initAuthCreds,
	jidNormalizedUser,
	proto,
	type SignalDataSet,
	type SignalDataTypeMap,
	type WAMessageKey,
} from "baileys";

import type { NormalizedInboundMessage } from "./types.js";

export type RetryMessageStoreConfig = {
	maxMessages: number;
	maxBytes: number;
	ttlSeconds: number;
};

type RetryMessageInput = {
	key: WAMessageKey;
	message: proto.IMessage | null | undefined;
};

type PreparedRetryMessage = {
	identity: [string, string, string, number, string];
	encoded: Buffer;
};

export class SQLiteBaileysState {
	readonly state: AuthenticationState;
	private readonly db: Database;
	private readonly creds: AuthenticationCreds;

	constructor(
		sessionDir: string,
		private readonly messageStoreConfig: RetryMessageStoreConfig,
	) {
		const legacyEntries = readdirSync(sessionDir).filter((entry) => entry.endsWith(".json"));
		if (legacyEntries.length > 0) {
			throw new Error(
				"legacy Baileys multi-file auth state requires explicit migration before SQLite startup",
			);
		}
		const databasePath = join(sessionDir, "baileys-state.sqlite");
		const db = new Database(databasePath, {
			create: true,
			strict: true,
		});
		try {
			chmodSync(databasePath, 0o600);
			db.exec("PRAGMA locking_mode = EXCLUSIVE");
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA synchronous = FULL");
			db.exec(`
			CREATE TABLE IF NOT EXISTS auth_creds (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS signal_keys (
				category TEXT NOT NULL,
				key_id TEXT NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (category, key_id)
			);
			CREATE TABLE IF NOT EXISTS retry_messages (
				account_jid TEXT NOT NULL,
				remote_jid TEXT NOT NULL,
				message_id TEXT NOT NULL,
				from_me INTEGER NOT NULL,
				participant_jid TEXT NOT NULL,
				message BLOB NOT NULL,
				byte_count INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				accessed_at INTEGER NOT NULL,
				PRIMARY KEY (
					account_jid,
					remote_jid,
					message_id,
					from_me,
					participant_jid
				)
			);
			CREATE INDEX IF NOT EXISTS retry_messages_age
			ON retry_messages (accessed_at, created_at);
			CREATE TABLE IF NOT EXISTS pending_inbound_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				provider_event_id TEXT NOT NULL UNIQUE,
				event TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
			secureStateFiles(sessionDir);
		} catch (error: unknown) {
			db.close();
			throw error;
		}
		this.db = db;
		this.creds = this.loadOrCreateCreds();
		this.state = {
			creds: this.creds,
			keys: {
				get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) =>
					this.getSignalKeys(type, ids),
				set: async (data: SignalDataSet) => this.setSignalKeys(data),
				clear: async () => {
					this.db.run("DELETE FROM signal_keys");
				},
			},
		};
	}

	async saveCreds(): Promise<void> {
		const value = serializeJson(this.creds);
		this.db.transaction(() => {
			this.db
				.query("INSERT OR REPLACE INTO auth_creds (singleton, value) VALUES (1, ?)")
				.run(value);
		})();
	}

	async getMessage(
		accountJid: string | undefined,
		key: WAMessageKey,
	): Promise<proto.IMessage | undefined> {
		const identity = retryMessageIdentity(accountJid, key);
		if (!identity) return undefined;
		const now = unixSeconds();
		this.deleteExpiredMessages(now);
		const row = this.db
			.query<{ message: Uint8Array }, [string, string, string, number, string]>(
				`SELECT message FROM retry_messages
				 WHERE account_jid = ? AND remote_jid = ? AND message_id = ?
				 AND from_me = ? AND participant_jid = ?`,
			)
			.get(...identity);
		if (!row) return undefined;
		this.db
			.query(
				`UPDATE retry_messages SET accessed_at = ?
				 WHERE account_jid = ? AND remote_jid = ? AND message_id = ?
				 AND from_me = ? AND participant_jid = ?`,
			)
			.run(now, ...identity);
		return proto.Message.decode(row.message);
	}

	storeMessage(
		accountJid: string | undefined,
		key: WAMessageKey,
		message: proto.IMessage | null | undefined,
	): boolean {
		return this.storeMessages(accountJid, [{ key, message }]) === 1;
	}

	storeMessages(
		accountJid: string | undefined,
		messages: ReadonlyArray<RetryMessageInput>,
	): number {
		const records = this.prepareRetryMessages(accountJid, messages);
		if (records.length === 0) return 0;
		const now = unixSeconds();
		this.db.transaction(() => {
			this.persistPreparedRetryMessages(records, now);
		})();
		return records.length;
	}

	storeInboundBatch(
		accountJid: string | undefined,
		items: ReadonlyArray<{ event: NormalizedInboundMessage; message: RetryMessageInput }>,
	): number {
		const records = this.prepareRetryMessages(
			accountJid,
			items.map(({ message }) => message),
		);
		if (records.length === 0) return 0;
		const eventIds = new Set(items.map(({ event }) => event.providerEventId));
		if (eventIds.size !== items.length) {
			throw new Error("inbound batch contains duplicate provider event identities");
		}
		const now = unixSeconds();
		this.db.transaction(() => {
			this.persistPreparedRetryMessages(records, now);
			const insert = this.db.query(
				`INSERT OR IGNORE INTO pending_inbound_events
				 (provider_event_id, event, created_at) VALUES (?, ?, ?)`,
			);
			for (const { event } of items) {
				insert.run(event.providerEventId, JSON.stringify(event), now);
			}
		})();
		return records.length;
	}

	pendingInboundEvents(): NormalizedInboundMessage[] {
		const rows = this.db
			.query<{ event: string }, []>("SELECT event FROM pending_inbound_events ORDER BY sequence")
			.all();
		return rows.map(({ event }) => parsePendingInboundEvent(event));
	}

	markInboundEventsHandedOff(providerEventIds: readonly string[]): void {
		if (providerEventIds.length === 0) return;
		this.db.transaction(() => {
			const remove = this.db.query(
				"DELETE FROM pending_inbound_events WHERE provider_event_id = ?",
			);
			for (const providerEventId of providerEventIds) remove.run(providerEventId);
		})();
	}

	close(): void {
		this.db.close();
	}

	private loadOrCreateCreds(): AuthenticationCreds {
		const row = this.db
			.query<{ value: string }, []>("SELECT value FROM auth_creds WHERE singleton = 1")
			.get();
		if (row) return parseJson(row.value) as AuthenticationCreds;
		const creds = initAuthCreds();
		this.db
			.query("INSERT INTO auth_creds (singleton, value) VALUES (1, ?)")
			.run(serializeJson(creds));
		return creds;
	}

	private prepareRetryMessages(
		accountJid: string | undefined,
		messages: ReadonlyArray<RetryMessageInput>,
	): PreparedRetryMessage[] {
		const records = messages.map(({ key, message }) => {
			const identity = retryMessageIdentity(accountJid, key);
			if (!identity || !message) {
				throw new Error("retry-message batch contains an incomplete message");
			}
			const encoded = Buffer.from(proto.Message.encode(message).finish());
			if (encoded.byteLength > this.messageStoreConfig.maxBytes) {
				throw new Error("retry-message batch contains a message above the byte cap");
			}
			return { identity, encoded };
		});
		if (records.length > this.messageStoreConfig.maxMessages) {
			throw new Error("retry-message batch exceeds the message count cap");
		}
		const batchBytes = records.reduce((total, record) => total + record.encoded.byteLength, 0);
		if (batchBytes > this.messageStoreConfig.maxBytes) {
			throw new Error("retry-message batch exceeds the aggregate byte cap");
		}
		const identities = new Set(records.map(({ identity }) => JSON.stringify(identity)));
		if (identities.size !== records.length) {
			throw new Error("retry-message batch contains duplicate message identities");
		}
		return records;
	}

	private persistPreparedRetryMessages(
		records: readonly PreparedRetryMessage[],
		now: number,
	): void {
		this.deleteExpiredMessages(now);
		const insert = this.db.query(
			`INSERT OR REPLACE INTO retry_messages (
				account_jid, remote_jid, message_id, from_me, participant_jid,
				message, byte_count, created_at, accessed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const { identity, encoded } of records) {
			insert.run(...identity, encoded, encoded.byteLength, now, now);
		}
		this.enforceMessageStoreCapacity();
		const contains = this.db.query<{ found: number }, [string, string, string, number, string]>(
			`SELECT 1 AS found FROM retry_messages
			 WHERE account_jid = ? AND remote_jid = ? AND message_id = ?
			 AND from_me = ? AND participant_jid = ?`,
		);
		for (const { identity } of records) {
			if (!contains.get(...identity)) {
				throw new Error("retry-message capacity cleanup rejected part of the batch");
			}
		}
	}

	private getSignalKeys<T extends keyof SignalDataTypeMap>(
		type: T,
		ids: string[],
	): { [id: string]: SignalDataTypeMap[T] } {
		const result: Partial<Record<string, SignalDataTypeMap[T]>> = {};
		const statement = this.db.query<{ value: string }, [string, string]>(
			"SELECT value FROM signal_keys WHERE category = ? AND key_id = ?",
		);
		for (const id of ids) {
			const row = statement.get(type, id);
			if (!row) continue;
			const parsed = parseJson<SignalDataTypeMap[T]>(row.value);
			result[id] =
				type === "app-state-sync-key"
					? Object.assign(proto.Message.AppStateSyncKeyData.fromObject(asRecord(parsed)), parsed)
					: parsed;
		}
		return result as { [id: string]: SignalDataTypeMap[T] };
	}

	private setSignalKeys(data: SignalDataSet): void {
		this.db.transaction(() => {
			for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
				const values = data[category];
				if (!values) continue;
				for (const [id, value] of Object.entries(values)) {
					if (value === null) {
						this.db
							.query("DELETE FROM signal_keys WHERE category = ? AND key_id = ?")
							.run(category, id);
					} else {
						this.db
							.query(
								"INSERT OR REPLACE INTO signal_keys (category, key_id, value) VALUES (?, ?, ?)",
							)
							.run(category, id, serializeJson(value));
					}
				}
			}
		})();
	}

	private deleteExpiredMessages(now: number): void {
		this.db
			.query("DELETE FROM retry_messages WHERE created_at < ?")
			.run(now - this.messageStoreConfig.ttlSeconds);
	}

	private enforceMessageStoreCapacity(): void {
		while (true) {
			const totals = this.db
				.query<{ message_count: number; byte_count: number }, []>(
					`SELECT COUNT(*) AS message_count,
					 COALESCE(SUM(byte_count), 0) AS byte_count FROM retry_messages`,
				)
				.get();
			if (
				!totals ||
				(totals.message_count <= this.messageStoreConfig.maxMessages &&
					totals.byte_count <= this.messageStoreConfig.maxBytes)
			) {
				return;
			}
			this.db.run(
				`DELETE FROM retry_messages WHERE rowid = (
					SELECT rowid FROM retry_messages
					ORDER BY accessed_at, created_at, rowid LIMIT 1
				)`,
			);
		}
	}
}

function retryMessageIdentity(
	accountJid: string | undefined,
	key: WAMessageKey,
): [string, string, string, number, string] | null {
	const rawAccount = accountJid?.trim();
	const rawRemoteJid = key.remoteJid?.trim();
	const messageId = key.id?.trim();
	if (!rawAccount || !rawRemoteJid || !messageId) return null;
	const account = jidNormalizedUser(rawAccount);
	const remoteJid = jidNormalizedUser(rawRemoteJid);
	const participant = key.participant?.trim();
	return [
		account,
		remoteJid,
		messageId,
		key.fromMe ? 1 : 0,
		participant ? jidNormalizedUser(participant) : "",
	];
}

function serializeJson(value: unknown): string {
	return JSON.stringify(value, BufferJSON.replacer);
}

function parseJson<T = unknown>(value: string): T {
	return JSON.parse(value, BufferJSON.reviver) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("invalid app-state-sync-key value in SQLite auth store");
	}
	return Object.fromEntries(Object.entries(value));
}

function parsePendingInboundEvent(value: string): NormalizedInboundMessage {
	const parsed = JSON.parse(value) as unknown;
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!("schemaVersion" in parsed) ||
		parsed.schemaVersion !== "clawdi.whatsapp.sidecar-event.v1" ||
		!("providerEventId" in parsed) ||
		typeof parsed.providerEventId !== "string" ||
		!/^message:[0-9a-f]{64}$/.test(parsed.providerEventId) ||
		!("messageId" in parsed) ||
		typeof parsed.messageId !== "string" ||
		!("chatJid" in parsed) ||
		typeof parsed.chatJid !== "string" ||
		!("actorJid" in parsed) ||
		typeof parsed.actorJid !== "string" ||
		!("fromMe" in parsed) ||
		parsed.fromMe !== false ||
		!("text" in parsed) ||
		typeof parsed.text !== "string"
	) {
		throw new Error("invalid pending WhatsApp inbound event in SQLite state");
	}
	return parsed as NormalizedInboundMessage;
}

function secureStateFiles(sessionDir: string): void {
	for (const name of [
		"baileys-state.sqlite",
		"baileys-state.sqlite-wal",
		"baileys-state.sqlite-shm",
	]) {
		const path = join(sessionDir, name);
		if (!existsSync(path)) continue;
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error(`Baileys state path must be a regular file: ${name}`);
		}
		chmodSync(path, 0o600);
	}
}

function unixSeconds(): number {
	return Math.floor(Date.now() / 1000);
}
