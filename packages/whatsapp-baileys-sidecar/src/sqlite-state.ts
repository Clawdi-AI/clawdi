import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
	type AuthenticationCreds,
	type AuthenticationState,
	BufferJSON,
	initAuthCreds,
	proto,
	type SignalDataSet,
	type SignalDataTypeMap,
	type WAMessage,
	type WAMessageKey,
} from "baileys";

import { aliasSet, normalizeChatAliases, normalizeSupportedJid } from "./jid.js";
import { BAILEYS_RELEASE } from "./release.js";
import {
	type AdvertisedRelease,
	type MessageReference,
	type NormalizedInboundMessage,
	OperationConflictError,
	type OperationResult,
	type OperationStatus,
	VersionRecoveryRequiredError,
} from "./types.js";

export const SQLITE_SCHEMA_VERSION = 2;

export type MessageStoreConfig = {
	maxMessages: number;
	maxBytes: number;
	ttlSeconds: number;
};

type StoredOperation = {
	request_hash: string;
	status: OperationStatus;
	result: string | null;
};

type MessageIdentity = {
	identityId: string;
	aliases: string[];
	messageId: string;
	fromMe: number;
};

export type OperationReservation =
	| { action: "execute" }
	| { action: "return"; result: OperationResult }
	| { action: "pending" };

export type ExistingOperationReservation = Exclude<OperationReservation, { action: "execute" }>;

export class SQLiteBaileysState {
	readonly state: AuthenticationState;
	private readonly db: Database;
	private readonly persistedReleaseValue: AdvertisedRelease;
	private releaseCompatible: boolean;

	constructor(
		readonly accountId: string,
		readonly sessionDir: string,
		private readonly messageStoreConfig: MessageStoreConfig,
	) {
		refuseLegacyJsonState(sessionDir);
		const databasePath = join(sessionDir, "baileys-state.sqlite");
		refuseUnsafeDatabasePath(databasePath);
		const db = new Database(databasePath, { create: true, strict: true });
		try {
			db.exec("PRAGMA busy_timeout = 0");
			db.exec("PRAGMA locking_mode = EXCLUSIVE");
			db.exec("PRAGMA foreign_keys = ON");
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA synchronous = FULL");
			this.refuseExistingAccountMismatch(db);
			migrateSchema(db);
			db.exec("BEGIN EXCLUSIVE; COMMIT");
			this.claimAccount(db);
			this.persistedReleaseValue = this.loadOrCreateRelease(db);
			this.releaseCompatible = releasesEqual(this.persistedReleaseValue, BAILEYS_RELEASE);
			db.run("UPDATE operations SET status = 'ambiguous' WHERE status = 'pending'");
			secureStateFiles(sessionDir);
		} catch (error: unknown) {
			db.close();
			throw error;
		}
		this.db = db;
		this.state = {
			creds: this.loadOrCreateCreds(),
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

	persistedRelease(): AdvertisedRelease {
		return this.persistedReleaseValue;
	}

	isReleaseCompatible(): boolean {
		return this.releaseCompatible;
	}

	acceptCurrentRelease(): void {
		this.db
			.query("INSERT OR REPLACE INTO metadata (key, value) VALUES ('baileys_release', ?)")
			.run(serializeJson(BAILEYS_RELEASE));
		Object.assign(this.persistedReleaseValue, BAILEYS_RELEASE);
		this.releaseCompatible = true;
	}

	assertReleaseCompatible(): void {
		if (!this.releaseCompatible) throw new VersionRecoveryRequiredError();
	}

	async saveCreds(): Promise<void> {
		this.db
			.query("INSERT OR REPLACE INTO auth_creds (singleton, value) VALUES (1, ?)")
			.run(serializeJson(this.state.creds));
		secureStateFiles(this.sessionDir);
	}

	async resetAccountState(): Promise<void> {
		const fresh = initAuthCreds();
		this.db.transaction(() => {
			this.db.run("DELETE FROM pending_callback_events");
			this.db.run("DELETE FROM operations");
			this.db.run("DELETE FROM stored_messages");
			this.db.run("DELETE FROM signal_keys");
			this.db
				.query("INSERT OR REPLACE INTO auth_creds (singleton, value) VALUES (1, ?)")
				.run(serializeJson(fresh));
		})();
		this.state.creds = fresh;
		secureStateFiles(this.sessionDir);
	}

	async getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
		const stored = this.findStoredMessage(key);
		return stored?.message ?? undefined;
	}

	findQuotedMessage(reference: MessageReference, defaultChatJid: string): WAMessage | undefined {
		const key: WAMessageKey = {
			remoteJid: reference.chatJid ?? defaultChatJid,
			remoteJidAlt: reference.chatJidAlt,
			id: reference.messageId,
			fromMe: reference.fromMe,
			participant: reference.participantJid,
			participantAlt: reference.participantJidAlt,
		};
		const stored = this.findStoredMessage(key);
		if (!stored) return undefined;
		if (reference.participantJid || reference.participantJidAlt) {
			const expected = normalizedUserAliases(reference.participantJid, reference.participantJidAlt);
			const actual = normalizedUserAliases(
				stored.waMessage.key.participant,
				stored.waMessage.key.participantAlt,
			);
			if (expected.length === 0 || expected.some((jid) => !actual.includes(jid))) {
				return undefined;
			}
		}
		return stored.waMessage;
	}

	storeMessage(message: WAMessage): void {
		this.db.transaction(() => this.persistMessage(message))();
		secureStateFiles(this.sessionDir);
	}

	storeInbound(event: NormalizedInboundMessage, message: WAMessage, queueCallback: boolean): void {
		this.db.transaction(() => {
			this.persistMessage(
				message,
				event.content.type === "media" ? event.content.mediaId : undefined,
			);
			if (queueCallback) {
				this.db
					.query(
						`INSERT OR IGNORE INTO pending_callback_events
						 (provider_event_id, event_json, created_at) VALUES (?, ?, ?)`,
					)
					.run(event.providerEventId, JSON.stringify(event), unixSeconds());
			}
		})();
		secureStateFiles(this.sessionDir);
	}

	pendingCallbackEvents(): NormalizedInboundMessage[] {
		const rows = this.db
			.query<{ event_json: string }, []>(
				"SELECT event_json FROM pending_callback_events ORDER BY sequence",
			)
			.all();
		return rows.map(({ event_json }) => parseCallbackEvent(event_json));
	}

	markCallbackEventSpooled(providerEventId: string): void {
		this.db
			.query("DELETE FROM pending_callback_events WHERE provider_event_id = ?")
			.run(providerEventId);
	}

	findOperation(
		operationId: string,
		requestHash: string,
	): ExistingOperationReservation | undefined {
		const existing = this.db
			.query<StoredOperation, [string]>(
				"SELECT request_hash, status, result FROM operations WHERE operation_id = ?",
			)
			.get(operationId);
		if (!existing) return undefined;
		if (existing.request_hash !== requestHash) throw new OperationConflictError();
		if (existing.status === "pending") return { action: "pending" };
		return {
			action: "return",
			result: existing.result
				? parseOperationResult(existing.result)
				: { operationId, status: existing.status, error: `operation_${existing.status}` },
		};
	}

	reserveOperation(operationId: string, requestHash: string): OperationReservation {
		const existing = this.findOperation(operationId, requestHash);
		if (existing) return existing;
		this.db
			.query(
				`INSERT INTO operations
				 (operation_id, request_hash, status, created_at, updated_at)
				 VALUES (?, ?, 'pending', ?, ?)`,
			)
			.run(operationId, requestHash, unixSeconds(), unixSeconds());
		return { action: "execute" };
	}

	completeOperation(
		operationId: string,
		requestHash: string,
		result: OperationResult,
		message?: WAMessage,
	): void {
		this.db.transaction(() => {
			if (message) this.persistMessage(message);
			const changed = this.db
				.query(
					`UPDATE operations SET status = 'completed', result = ?, updated_at = ?
					 WHERE operation_id = ? AND request_hash = ? AND status = 'pending'`,
				)
				.run(JSON.stringify(result), unixSeconds(), operationId, requestHash);
			if (changed.changes !== 1)
				throw new Error("operation completion lost its pending reservation");
		})();
		secureStateFiles(this.sessionDir);
	}

	markOperationAmbiguous(operationId: string, requestHash: string): OperationResult {
		const result: OperationResult = {
			operationId,
			status: "ambiguous",
			error: "provider_outcome_unknown",
		};
		this.setOperationResult(operationId, requestHash, result);
		return result;
	}

	markOperationFailed(operationId: string, requestHash: string, error: string): OperationResult {
		const result: OperationResult = { operationId, status: "failed", error: error.slice(0, 120) };
		this.setOperationResult(operationId, requestHash, result);
		return result;
	}

	mediaMessage(
		mediaId: string,
	): { message: WAMessage; contentType: string; fileName?: string } | undefined {
		const row = this.db
			.query<
				{ wamessage: Uint8Array; mime_type: string | null; file_name: string | null },
				[string]
			>(
				`SELECT wamessage, mime_type, file_name FROM stored_messages
				 WHERE media_id = ? LIMIT 1`,
			)
			.get(mediaId);
		if (!row) return undefined;
		return {
			message: proto.WebMessageInfo.decode(row.wamessage) as WAMessage,
			contentType: safeMimeType(row.mime_type),
			...(row.file_name ? { fileName: row.file_name } : {}),
		};
	}

	close(): void {
		this.db.close();
	}

	private claimAccount(db: Database): void {
		const row = db
			.query<{ value: string }, []>("SELECT value FROM metadata WHERE key = 'account_id'")
			.get();
		if (row && row.value !== this.accountId) {
			throw new Error(
				`Baileys state account mismatch: database belongs to ${row.value}, not ${this.accountId}`,
			);
		}
		if (!row) {
			db.query("INSERT INTO metadata (key, value) VALUES ('account_id', ?)").run(this.accountId);
		}
	}

	private refuseExistingAccountMismatch(db: Database): void {
		const metadataTable = db
			.query<{ found: number }, []>(
				"SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'metadata'",
			)
			.get();
		if (!metadataTable) return;
		const row = db
			.query<{ value: string }, []>("SELECT value FROM metadata WHERE key = 'account_id'")
			.get();
		if (row && row.value !== this.accountId) {
			throw new Error(
				`Baileys state account mismatch: database belongs to ${row.value}, not ${this.accountId}`,
			);
		}
	}

	private loadOrCreateRelease(db: Database): AdvertisedRelease {
		const row = db
			.query<{ value: string }, []>("SELECT value FROM metadata WHERE key = 'baileys_release'")
			.get();
		if (row) return parseRelease(row.value);
		db.query("INSERT INTO metadata (key, value) VALUES ('baileys_release', ?)").run(
			serializeJson(BAILEYS_RELEASE),
		);
		return cloneRelease(BAILEYS_RELEASE);
	}

	private loadOrCreateCreds(): AuthenticationCreds {
		const row = this.db
			.query<{ value: string }, []>("SELECT value FROM auth_creds WHERE singleton = 1")
			.get();
		if (row) return parseJson<AuthenticationCreds>(row.value);
		const creds = initAuthCreds();
		this.db
			.query("INSERT INTO auth_creds (singleton, value) VALUES (1, ?)")
			.run(serializeJson(creds));
		return creds;
	}

	private getSignalKeys<T extends keyof SignalDataTypeMap>(
		type: T,
		ids: string[],
	): { [id: string]: SignalDataTypeMap[T] };
	private getSignalKeys(
		type: keyof SignalDataTypeMap,
		ids: string[],
	): Record<string, SignalDataTypeMap[keyof SignalDataTypeMap]> {
		const result: Partial<Record<string, SignalDataTypeMap[keyof SignalDataTypeMap]>> = {};
		const statement = this.db.query<{ value: string }, [string, string]>(
			"SELECT value FROM signal_keys WHERE category = ? AND key_id = ?",
		);
		for (const id of ids) {
			const row = statement.get(type, id);
			if (!row) continue;
			const parsed = parseJson<SignalDataTypeMap[keyof SignalDataTypeMap]>(row.value);
			result[id] =
				type === "app-state-sync-key"
					? proto.Message.AppStateSyncKeyData.fromObject(asRecord(parsed))
					: parsed;
		}
		return result as Record<string, SignalDataTypeMap[keyof SignalDataTypeMap]>;
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
		secureStateFiles(this.sessionDir);
	}

	private findStoredMessage(
		key: WAMessageKey,
	): { message: proto.IMessage; waMessage: WAMessage } | undefined {
		const messageId = key.id?.trim();
		const remoteJid = key.remoteJid?.trim();
		if (!messageId || !remoteJid) return undefined;
		const pair = normalizeChatAliases(remoteJid, key.remoteJidAlt ?? undefined);
		this.deleteExpiredMessages();
		for (const alias of aliasSet(pair)) {
			const row = this.db
				.query<
					{ identity_id: string; message: Uint8Array; wamessage: Uint8Array },
					[string, string, string, number]
				>(
					`SELECT m.identity_id, m.message, m.wamessage
					 FROM message_aliases a JOIN stored_messages m ON m.identity_id = a.identity_id
					 WHERE a.account_id = ? AND a.chat_alias = ? AND a.message_id = ? AND a.from_me = ?
					 LIMIT 1`,
				)
				.get(this.accountId, alias, messageId, key.fromMe ? 1 : 0);
			if (!row) continue;
			this.db
				.query("UPDATE stored_messages SET accessed_at = ? WHERE identity_id = ?")
				.run(unixSeconds(), row.identity_id);
			return {
				message: proto.Message.decode(row.message),
				waMessage: proto.WebMessageInfo.decode(row.wamessage) as WAMessage,
			};
		}
		return undefined;
	}

	private persistMessage(message: WAMessage, mediaId?: string): void {
		if (!message.message) throw new Error("message persistence requires provider message content");
		const identity = this.messageIdentity(message.key);
		const encodedMessage = Buffer.from(proto.Message.encode(message.message).finish());
		const encodedWaMessage = Buffer.from(proto.WebMessageInfo.encode(message).finish());
		const totalBytes = encodedMessage.byteLength + encodedWaMessage.byteLength;
		if (totalBytes > this.messageStoreConfig.maxBytes) {
			throw new Error("message exceeds the durable message store byte cap");
		}
		const metadata = mediaMetadata(message);
		const now = unixSeconds();
		this.deleteExpiredMessages(now);
		this.db
			.query(
				`INSERT OR REPLACE INTO stored_messages
				 (identity_id, account_id, message_id, from_me, message, wamessage, byte_count,
				  created_at, accessed_at, media_id, mime_type, file_name)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				identity.identityId,
				this.accountId,
				identity.messageId,
				identity.fromMe,
				encodedMessage,
				encodedWaMessage,
				totalBytes,
				now,
				now,
				mediaId ?? null,
				metadata.mimeType ?? null,
				metadata.fileName ?? null,
			);
		this.db.query("DELETE FROM message_aliases WHERE identity_id = ?").run(identity.identityId);
		const insertAlias = this.db.query(
			`INSERT OR REPLACE INTO message_aliases
			 (account_id, chat_alias, message_id, from_me, identity_id) VALUES (?, ?, ?, ?, ?)`,
		);
		for (const alias of identity.aliases) {
			insertAlias.run(
				this.accountId,
				alias,
				identity.messageId,
				identity.fromMe,
				identity.identityId,
			);
		}
		this.enforceMessageCapacity(identity.identityId);
	}

	private messageIdentity(key: WAMessageKey): MessageIdentity {
		const messageId = key.id?.trim();
		if (!messageId) throw new Error("message persistence requires a message id");
		const remoteJid = key.remoteJid?.trim();
		if (!remoteJid) throw new Error("message persistence requires a chat jid");
		const aliases = aliasSet(normalizeChatAliases(remoteJid, key.remoteJidAlt ?? undefined));
		const fromMe = key.fromMe ? 1 : 0;
		const existingIdentities = new Set<string>();
		for (const alias of aliases) {
			const existing = this.db
				.query<{ identity_id: string }, [string, string, string, number]>(
					`SELECT identity_id FROM message_aliases
					 WHERE account_id = ? AND chat_alias = ? AND message_id = ? AND from_me = ?`,
				)
				.get(this.accountId, alias, messageId, fromMe);
			if (existing) existingIdentities.add(existing.identity_id);
		}
		if (existingIdentities.size > 1) {
			throw new Error("message aliases conflict with multiple durable message identities");
		}
		const existingIdentity = [...existingIdentities][0];
		if (existingIdentity) {
			const existingAliases = this.db
				.query<{ chat_alias: string }, [string]>(
					"SELECT chat_alias FROM message_aliases WHERE identity_id = ?",
				)
				.all(existingIdentity)
				.map(({ chat_alias }) => chat_alias);
			return {
				identityId: existingIdentity,
				aliases: [...new Set([...aliases, ...existingAliases])].sort(),
				messageId,
				fromMe,
			};
		}
		const identityId = createHash("sha256")
			.update(JSON.stringify([this.accountId, aliases, messageId, fromMe]))
			.digest("hex");
		return { identityId, aliases, messageId, fromMe };
	}

	private deleteExpiredMessages(now = unixSeconds()): void {
		this.db
			.query("DELETE FROM stored_messages WHERE created_at < ?")
			.run(now - this.messageStoreConfig.ttlSeconds);
	}

	private enforceMessageCapacity(protectedIdentity: string): void {
		while (true) {
			const totals = this.db
				.query<{ message_count: number; byte_count: number }, []>(
					"SELECT COUNT(*) AS message_count, COALESCE(SUM(byte_count), 0) AS byte_count FROM stored_messages",
				)
				.get();
			if (
				!totals ||
				(totals.message_count <= this.messageStoreConfig.maxMessages &&
					totals.byte_count <= this.messageStoreConfig.maxBytes)
			) {
				break;
			}
			const removed = this.db
				.query(
					`DELETE FROM stored_messages WHERE identity_id = (
					 SELECT identity_id FROM stored_messages WHERE identity_id != ?
					 ORDER BY accessed_at, created_at, identity_id LIMIT 1
					)`,
				)
				.run(protectedIdentity);
			if (removed.changes !== 1)
				throw new Error("message store capacity cannot retain the new message");
		}
	}

	private setOperationResult(
		operationId: string,
		requestHash: string,
		result: OperationResult,
	): void {
		const changed = this.db
			.query(
				`UPDATE operations SET status = ?, result = ?, updated_at = ?
				 WHERE operation_id = ? AND request_hash = ? AND status = 'pending'`,
			)
			.run(result.status, JSON.stringify(result), unixSeconds(), operationId, requestHash);
		if (changed.changes !== 1) throw new Error("operation result lost its pending reservation");
	}
}

function migrateSchema(db: Database): void {
	const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
	let version = row?.user_version ?? 0;
	if (version > SQLITE_SCHEMA_VERSION) {
		throw new Error(
			`Baileys state schema ${version} is newer than supported ${SQLITE_SCHEMA_VERSION}`,
		);
	}
	while (version < SQLITE_SCHEMA_VERSION) {
		const nextVersion = version + 1;
		db.exec("BEGIN IMMEDIATE");
		try {
			if (nextVersion === 1) migrateToVersion1(db);
			if (nextVersion === 2) migrateToVersion2(db);
			db.exec(`PRAGMA user_version = ${nextVersion}`);
			db.exec("COMMIT");
			version = nextVersion;
		} catch (error: unknown) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}

function migrateToVersion1(db: Database): void {
	db.exec(`
		CREATE TABLE metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE auth_creds (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			value TEXT NOT NULL
		);
		CREATE TABLE signal_keys (
			category TEXT NOT NULL,
			key_id TEXT NOT NULL,
			value TEXT NOT NULL,
			PRIMARY KEY (category, key_id)
		);
		CREATE TABLE stored_messages (
			identity_id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			from_me INTEGER NOT NULL CHECK (from_me IN (0, 1)),
			message BLOB NOT NULL,
			wamessage BLOB NOT NULL,
			byte_count INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			accessed_at INTEGER NOT NULL
		);
		CREATE TABLE message_aliases (
			account_id TEXT NOT NULL,
			chat_alias TEXT NOT NULL,
			message_id TEXT NOT NULL,
			from_me INTEGER NOT NULL CHECK (from_me IN (0, 1)),
			identity_id TEXT NOT NULL REFERENCES stored_messages(identity_id) ON DELETE CASCADE,
			PRIMARY KEY (account_id, chat_alias, message_id, from_me)
		);
		CREATE TABLE pending_callback_events (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			provider_event_id TEXT NOT NULL UNIQUE,
			event_json TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX stored_messages_age ON stored_messages(accessed_at, created_at);
	`);
}

function migrateToVersion2(db: Database): void {
	db.exec(`
		ALTER TABLE stored_messages ADD COLUMN media_id TEXT;
		ALTER TABLE stored_messages ADD COLUMN mime_type TEXT;
		ALTER TABLE stored_messages ADD COLUMN file_name TEXT;
		CREATE UNIQUE INDEX stored_messages_media_id
		ON stored_messages(media_id) WHERE media_id IS NOT NULL;
		CREATE TABLE operations (
			operation_id TEXT PRIMARY KEY,
			request_hash TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'ambiguous')),
			result TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);
}

function refuseLegacyJsonState(sessionDir: string): void {
	const legacyEntries = readdirSync(sessionDir).filter((entry) => entry.endsWith(".json"));
	if (legacyEntries.length > 0) {
		throw new Error(
			"legacy Baileys JSON auth state requires an explicit migration before SQLite startup",
		);
	}
}

function refuseUnsafeDatabasePath(path: string): void {
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error("Baileys state database must be a regular file");
	}
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
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new Error(`unsafe Baileys state file: ${name}`);
		chmodSync(path, 0o600);
	}
}

function serializeJson(value: unknown): string {
	return JSON.stringify(value, BufferJSON.replacer);
}

function parseJson<T>(value: string): T {
	return JSON.parse(value, BufferJSON.reviver) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("invalid app-state-sync-key value in SQLite auth store");
	}
	return Object.fromEntries(Object.entries(value));
}

function parseRelease(value: string): AdvertisedRelease {
	const parsed = parseJson<unknown>(value);
	if (!isRecord(parsed) || !Array.isArray(parsed.version) || parsed.version.length !== 3) {
		throw new Error("invalid persisted Baileys release metadata");
	}
	if (
		parsed.packageName !== "@whiskeysockets/baileys" ||
		typeof parsed.packageVersion !== "string" ||
		typeof parsed.sourceCommit !== "string" ||
		!parsed.version.every((part) => Number.isSafeInteger(part))
	) {
		throw new Error("invalid persisted Baileys release metadata");
	}
	return parsed as AdvertisedRelease;
}

function cloneRelease(release: AdvertisedRelease): AdvertisedRelease {
	return {
		...release,
		version: [...release.version],
	};
}

function releasesEqual(left: AdvertisedRelease, right: AdvertisedRelease): boolean {
	return (
		left.packageName === right.packageName &&
		left.packageVersion === right.packageVersion &&
		left.sourceCommit === right.sourceCommit &&
		left.version.every((part, index) => part === right.version[index])
	);
}

function parseOperationResult(value: string): OperationResult {
	const parsed = JSON.parse(value) as unknown;
	if (!isRecord(parsed) || typeof parsed.operationId !== "string") {
		throw new Error("invalid persisted operation result");
	}
	if (!new Set(["completed", "failed", "ambiguous"]).has(String(parsed.status))) {
		throw new Error("invalid persisted operation result status");
	}
	return parsed as OperationResult;
}

function parseCallbackEvent(value: string): NormalizedInboundMessage {
	const parsed = JSON.parse(value) as unknown;
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== "clawdi.whatsapp.sidecar-event.v1" ||
		typeof parsed.providerEventId !== "string" ||
		!/^message:[0-9a-f]{64}$/.test(parsed.providerEventId)
	) {
		throw new Error("invalid pending callback event in SQLite state");
	}
	return parsed as NormalizedInboundMessage;
}

function normalizedUserAliases(primary?: string | null, alt?: string | null): string[] {
	const values = [primary, alt].flatMap((value) => {
		if (!value) return [];
		const normalized = normalizeSupportedJid(value);
		return normalized && normalized.kind !== "group" ? [normalized.jid] : [];
	});
	return [...new Set(values)].sort();
}

function mediaMetadata(message: WAMessage): { mimeType?: string; fileName?: string } {
	const content = message.message;
	const media =
		content?.imageMessage ??
		content?.videoMessage ??
		content?.audioMessage ??
		content?.documentMessage ??
		content?.stickerMessage;
	if (!media) return {};
	return {
		...(media.mimetype ? { mimeType: media.mimetype.slice(0, 255) } : {}),
		...("fileName" in media && media.fileName ? { fileName: media.fileName.slice(0, 255) } : {}),
	};
}

function safeMimeType(value: string | null): string {
	return value && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)
		? value
		: "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unixSeconds(): number {
	return Math.floor(Date.now() / 1000);
}
