import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AuthenticationCreds,
	type AuthenticationState,
	BufferJSON,
	type CacheStore,
	initAuthCreds,
	jidDecode,
	proto,
	type SignalDataSet,
	type SignalDataTypeMap,
	type WAVersion,
} from "baileys";

import { AUDITED_BAILEYS_RELEASE, AUDITED_WHATSAPP_WEB_VERSION_TEXT } from "./audited-version.js";
import { assertOwnedDirectory } from "./filesystem-security.js";
import { Database } from "./sqlite-database.js";

export type ProviderMessageEvent = {
	sequence: number;
	eventType: "messages.upsert";
	messageId: string;
	remoteJid: string;
	remoteJidAlt?: string;
	participant?: string;
	participantAlt?: string;
	fromMe: false;
	pushName?: string;
	messageTimestamp?: number;
	messageProtoBase64: string;
};

export type ProviderMessageEventInput = Omit<ProviderMessageEvent, "sequence">;

export type ProviderInboxConfig = {
	maxEvents: number;
	maxBytes: number;
};

export type ProviderStateFailureOperation =
	| "auth_creds_write"
	| "physical_auth_reset"
	| "signal_key_read"
	| "signal_key_write"
	| "signal_key_clear"
	| "retry_cache_read"
	| "retry_cache_write"
	| "retry_message_read"
	| "retry_message_write"
	| "provider_inbox_write"
	| "provider_inbox_read"
	| "provider_inbox_ack";

type ProviderStateFailureHandler = (operation: ProviderStateFailureOperation, error: Error) => void;

const STATE_SCHEMA_VERSION = "1";
const STATE_DATABASE_FILE = "provider-state.sqlite";
const MAX_CREDS_BYTES = 4 * 1024 * 1024;
const MAX_SIGNAL_KEY_ID_BYTES = 512;
const MAX_SIGNAL_KEY_VALUE_BYTES = 1024 * 1024;
const MAX_SIGNAL_KEY_MUTATIONS = 2048;
const MAX_SIGNAL_KEY_GET_IDS = 2048;
const MAX_SIGNAL_KEY_COUNT = 250_000;
const MAX_SIGNAL_KEY_BYTES = 512 * 1024 * 1024;
const RETRY_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_RETRY_CACHE_KEY_BYTES = 512;
const MAX_RETRY_CACHE_VALUE_BYTES = 64 * 1024;
const MAX_RETRY_CACHE_ENTRIES = 10_000;
const MAX_RETRY_CACHE_BYTES = 16 * 1024 * 1024;
const RETRY_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRY_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_RETRY_MESSAGES = 10_000;
const MAX_RETRY_MESSAGES_BYTES = 256 * 1024 * 1024;

const SIGNAL_CATEGORIES = new Set<keyof SignalDataTypeMap>([
	"pre-key",
	"session",
	"sender-key",
	"sender-key-memory",
	"app-state-sync-key",
	"app-state-sync-version",
	"lid-mapping",
	"device-list",
	"tctoken",
	"identity-key",
]);

const LEGACY_STATE_NAMES = new Set([
	"creds.json",
	"retry-counters.json",
	"provider-inbox",
	".clawdi-provider-owner.lock",
]);

export class SQLiteProviderState {
	readonly state: AuthenticationState;
	readonly retryCounterCache: CacheStore;
	readonly databasePath: string;

	private readonly db: Database;
	private readonly creds: AuthenticationCreds;
	private closed = false;

	constructor(
		sessionDir: string,
		sessionId: string,
		webVersion: WAVersion,
		private readonly inboxConfig: ProviderInboxConfig,
		private readonly onFailure?: ProviderStateFailureHandler,
	) {
		validateSessionId(sessionId);
		validateInboxConfig(inboxConfig);
		prepareSessionDirectory(sessionDir);
		rejectLegacyState(sessionDir);
		secureStateFiles(sessionDir);
		this.databasePath = join(sessionDir, STATE_DATABASE_FILE);
		const databaseExisted = existsSync(this.databasePath);
		const db = new Database(this.databasePath);
		try {
			chmodSync(this.databasePath, 0o600);
			configureDatabase(db);
			db.transaction(() => {
				createSchema(db);
				validateOrBindMetadata(db, {
					sessionId,
					webVersion,
					databaseExisted,
				});
			})();
			assertDatabaseIntegrity(db);
			validatePendingProviderEvents(db, inboxConfig);
			secureStateFiles(sessionDir);
		} catch (error: unknown) {
			db.close();
			throw error;
		}
		this.db = db;
		let creds: AuthenticationCreds;
		try {
			creds = this.loadOrCreateCreds();
		} catch (error: unknown) {
			db.close();
			throw error;
		}
		this.creds = creds;
		this.state = {
			creds: this.creds,
			keys: {
				get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) =>
					this.withFailure("signal_key_read", () => this.getSignalKeys(type, ids)),
				set: async (data: SignalDataSet) =>
					this.withFailure("signal_key_write", () => this.setSignalKeys(data)),
				clear: async () => this.withFailure("signal_key_clear", () => this.clearSignalKeys()),
			},
		};
		this.retryCounterCache = new SQLiteRetryCounterCache(this);
	}

	saveCreds(update?: Partial<AuthenticationCreds>): void {
		this.withFailure("auth_creds_write", () => {
			if (update) Object.assign(this.creds, update);
			validateAuthenticationCreds(this.creds);
			const persistedCreds = credentialsForPersistence(this.creds);
			validateAuthenticationCreds(persistedCreds);
			const value = serializeBufferJson(persistedCreds, "Baileys auth credentials");
			if (Buffer.byteLength(value) > MAX_CREDS_BYTES) {
				throw new Error("Baileys auth credentials exceed the durable size limit");
			}
			this.transaction(() => {
				this.db
					.query("INSERT OR REPLACE INTO auth_creds (singleton, value) VALUES (1, ?)")
					.run(value);
			});
		});
	}

	appendProviderEvents(events: readonly ProviderMessageEventInput[]): void {
		if (events.length === 0) return;
		this.withFailure("provider_inbox_write", () => {
			if (events.length > this.inboxConfig.maxEvents) {
				throw new ProviderInboxCapacityError();
			}
			const prepared: Array<{ value: string; byteCount: number }> = [];
			let batchBytes = 0;
			for (const event of events) {
				validateProviderMessageEventInput(event);
				const value = JSON.stringify(event);
				const byteCount = Buffer.byteLength(value);
				batchBytes += byteCount;
				if (batchBytes > this.inboxConfig.maxBytes) {
					throw new ProviderInboxCapacityError();
				}
				prepared.push({ value, byteCount });
			}
			this.transaction(() => {
				const totals = providerInboxTotals(this.db);
				if (
					totals.eventCount + prepared.length > this.inboxConfig.maxEvents ||
					totals.byteCount + batchBytes > this.inboxConfig.maxBytes
				) {
					throw new ProviderInboxCapacityError();
				}
				const insert = this.db.query(
					`INSERT INTO provider_inbox (event_json, byte_count, created_at)
					 VALUES (?, ?, ?)`,
				);
				const createdAt = Date.now();
				for (const event of prepared) insert.run(event.value, event.byteCount, createdAt);
			});
		});
	}

	providerEvents(limit: number): ProviderMessageEvent[] {
		return this.withFailure("provider_inbox_read", () => {
			if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
				throw new Error("provider inbox limit must be between 1 and 100");
			}
			const rows = this.db
				.query<{ sequence: number; event_json: string; byte_count: number }, [number]>(
					`SELECT sequence, event_json, byte_count FROM provider_inbox
					 ORDER BY sequence LIMIT ?`,
				)
				.all(limit);
			return rows.map((row) => {
				assertStoredTextBytes(
					row.event_json,
					row.byte_count,
					this.inboxConfig.maxBytes,
					"provider inbox event",
				);
				return parseProviderMessageEvent(row.event_json, row.sequence);
			});
		});
	}

	acknowledgeProviderEvents(throughSequence: number): void {
		this.withFailure("provider_inbox_ack", () => {
			if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) {
				throw new Error("provider inbox acknowledgement must be a positive integer");
			}
			this.transaction(() => {
				this.db.query("DELETE FROM provider_inbox WHERE sequence <= ?").run(throughSequence);
			});
		});
	}

	resetPhysicalAuth(): void {
		this.withFailure("physical_auth_reset", () => {
			const fresh = initAuthCreds();
			validateAuthenticationCreds(fresh);
			const serialized = serializeBufferJson(fresh, "Baileys auth credentials");
			this.transaction(() => {
				this.db.exec(`
					DELETE FROM signal_keys;
					DELETE FROM retry_cache;
					DELETE FROM retry_messages;
					DELETE FROM provider_inbox;
				`);
				this.db.run("INSERT OR REPLACE INTO auth_creds (singleton, value) VALUES (1, ?)", [
					serialized,
				]);
			});
			for (const key of Object.keys(this.creds) as Array<keyof AuthenticationCreds>) {
				delete this.creds[key];
			}
			Object.assign(this.creds, fresh);
		});
	}

	storeRetryMessage(remoteJid: string, messageId: string, message: Uint8Array): void {
		this.withFailure("retry_message_write", () => {
			validateRetryMessageIdentity(remoteJid, messageId);
			const encoded = Buffer.from(message);
			if (encoded.length < 1 || encoded.length > MAX_RETRY_MESSAGE_BYTES) {
				throw new Error("retry message exceeds the durable size limit");
			}
			const now = Date.now();
			this.transaction(() => {
				this.db.query("DELETE FROM retry_messages WHERE expires_at <= ?").run(now);
				this.db
					.query(
						`INSERT OR REPLACE INTO retry_messages
						 (remote_jid, message_id, message, byte_count, expires_at)
						 VALUES (?, ?, ?, ?, ?)`,
					)
					.run(remoteJid, messageId, encoded, encoded.length, now + RETRY_MESSAGE_TTL_MS);
				const totals = this.db
					.query<{ message_count: number; byte_count: number }, []>(
						`SELECT COUNT(*) AS message_count,
						 COALESCE(SUM(byte_count), 0) AS byte_count FROM retry_messages`,
					)
					.get();
				if (
					!totals ||
					totals.message_count > MAX_RETRY_MESSAGES ||
					totals.byte_count > MAX_RETRY_MESSAGES_BYTES
				) {
					throw new Error("retry message store capacity exceeded");
				}
			});
		});
	}

	getRetryMessage(
		remoteJid: string | null | undefined,
		messageId: string | null | undefined,
	): proto.IMessage | undefined {
		return this.withFailure("retry_message_read", () => {
			if (!remoteJid || !messageId) return undefined;
			validateRetryMessageIdentity(remoteJid, messageId);
			const row = this.db
				.query<{ message: Uint8Array; byte_count: number; expires_at: number }, [string, string]>(
					`SELECT message, byte_count, expires_at FROM retry_messages
					 WHERE remote_jid = ? AND message_id = ?`,
				)
				.get(remoteJid, messageId);
			if (!row) return undefined;
			assertStoredBytes(row.message, row.byte_count, MAX_RETRY_MESSAGE_BYTES, "retry message");
			if (row.expires_at <= Date.now()) {
				this.transaction(() => {
					this.db
						.query("DELETE FROM retry_messages WHERE remote_jid = ? AND message_id = ?")
						.run(remoteJid, messageId);
				});
				return undefined;
			}
			return proto.Message.decode(row.message);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			this.db.close();
		}
	}

	getRetryCounter<T>(key: string): T | undefined {
		return this.withFailure("retry_cache_read", () => {
			validateRetryCacheKey(key);
			const row = this.db
				.query<{ value: string; byte_count: number; expires_at: number }, [string]>(
					"SELECT value, byte_count, expires_at FROM retry_cache WHERE cache_key = ?",
				)
				.get(key);
			if (!row) return undefined;
			assertStoredTextBytes(
				row.value,
				row.byte_count,
				MAX_RETRY_CACHE_VALUE_BYTES,
				"retry cache value",
			);
			if (row.expires_at <= Date.now()) {
				this.transaction(() => {
					this.db.query("DELETE FROM retry_cache WHERE cache_key = ?").run(key);
				});
				return undefined;
			}
			return parseBufferJson<T>(row.value, "retry cache value");
		});
	}

	setRetryCounter<T>(key: string, value: T): void {
		this.withFailure("retry_cache_write", () => {
			validateRetryCacheKey(key);
			const serialized = serializeBufferJson(value, "retry cache value");
			const byteCount = Buffer.byteLength(serialized);
			if (byteCount > MAX_RETRY_CACHE_VALUE_BYTES) {
				throw new Error("retry cache value exceeds the durable size limit");
			}
			this.transaction(() => {
				this.db.query("DELETE FROM retry_cache WHERE expires_at <= ?").run(Date.now());
				this.db
					.query(
						`INSERT OR REPLACE INTO retry_cache
						 (cache_key, value, byte_count, expires_at) VALUES (?, ?, ?, ?)`,
					)
					.run(key, serialized, byteCount, Date.now() + RETRY_CACHE_TTL_MS);
				const totals = this.db
					.query<{ entry_count: number; byte_count: number }, []>(
						`SELECT COUNT(*) AS entry_count,
						 COALESCE(SUM(byte_count), 0) AS byte_count FROM retry_cache`,
					)
					.get();
				if (
					!totals ||
					totals.entry_count > MAX_RETRY_CACHE_ENTRIES ||
					totals.byte_count > MAX_RETRY_CACHE_BYTES
				) {
					throw new Error("retry cache capacity exceeded");
				}
			});
		});
	}

	deleteRetryCounter(key: string): void {
		this.withFailure("retry_cache_write", () => {
			validateRetryCacheKey(key);
			this.transaction(() => {
				this.db.query("DELETE FROM retry_cache WHERE cache_key = ?").run(key);
			});
		});
	}

	clearRetryCounters(): void {
		this.withFailure("retry_cache_write", () => {
			this.transaction(() => this.db.run("DELETE FROM retry_cache"));
		});
	}

	private loadOrCreateCreds(): AuthenticationCreds {
		const row = this.db
			.query<{ value: string }, []>("SELECT value FROM auth_creds WHERE singleton = 1")
			.get();
		if (row) {
			if (Buffer.byteLength(row.value) > MAX_CREDS_BYTES) {
				throw new Error("corrupt auth credentials: value exceeds the durable size limit");
			}
			return validateAuthenticationCreds(parseBufferJson(row.value, "auth credentials"));
		}
		const creds = initAuthCreds();
		const serialized = serializeBufferJson(creds, "auth credentials");
		this.transaction(() => {
			this.db.query("INSERT INTO auth_creds (singleton, value) VALUES (1, ?)").run(serialized);
		});
		return creds;
	}

	private getSignalKeys<T extends keyof SignalDataTypeMap>(
		type: T,
		ids: string[],
	): { [id: string]: SignalDataTypeMap[T] } {
		validateSignalCategory(type);
		if (ids.length > MAX_SIGNAL_KEY_GET_IDS) {
			throw new Error("Signal key read exceeds the key count limit");
		}
		const result: Record<string, unknown> = {};
		const statement = this.db.query<{ value: string; byte_count: number }, [string, string]>(
			"SELECT value, byte_count FROM signal_keys WHERE category = ? AND key_id = ?",
		);
		for (const id of ids) {
			validateSignalKeyId(id);
			const row = statement.get(type, id);
			if (!row) continue;
			assertStoredTextBytes(row.value, row.byte_count, MAX_SIGNAL_KEY_VALUE_BYTES, "Signal key");
			const parsed = parseBufferJson<SignalDataTypeMap[T]>(row.value, "Signal key");
			result[id] =
				type === "app-state-sync-key"
					? proto.Message.AppStateSyncKeyData.fromObject(asRecord(parsed))
					: parsed;
		}
		return result as { [id: string]: SignalDataTypeMap[T] };
	}

	private setSignalKeys(data: SignalDataSet): void {
		const prepared: Array<{
			category: keyof SignalDataTypeMap;
			id: string;
			value: string | null;
			byteCount: number;
		}> = [];
		for (const category of Object.keys(data)) {
			validateSignalCategory(category);
			const values = data[category];
			if (!values) continue;
			for (const [id, value] of Object.entries(values)) {
				validateSignalKeyId(id);
				const serialized =
					value === null ? null : serializeBufferJson(value, `Signal key ${category}/${id}`);
				const byteCount = serialized === null ? 0 : Buffer.byteLength(serialized);
				if (byteCount > MAX_SIGNAL_KEY_VALUE_BYTES) {
					throw new Error("Signal key value exceeds the durable size limit");
				}
				prepared.push({ category, id, value: serialized, byteCount });
			}
		}
		if (prepared.length > MAX_SIGNAL_KEY_MUTATIONS) {
			throw new Error("Signal key update exceeds the mutation count limit");
		}
		this.transaction(() => {
			const remove = this.db.query("DELETE FROM signal_keys WHERE category = ? AND key_id = ?");
			const upsert = this.db.query(
				`INSERT OR REPLACE INTO signal_keys
				 (category, key_id, value, byte_count) VALUES (?, ?, ?, ?)`,
			);
			for (const entry of prepared) {
				if (entry.value === null) remove.run(entry.category, entry.id);
				else upsert.run(entry.category, entry.id, entry.value, entry.byteCount);
			}
			const totals = this.db
				.query<{ key_count: number; byte_count: number }, []>(
					`SELECT COUNT(*) AS key_count,
					 COALESCE(SUM(byte_count), 0) AS byte_count FROM signal_keys`,
				)
				.get();
			if (
				!totals ||
				totals.key_count > MAX_SIGNAL_KEY_COUNT ||
				totals.byte_count > MAX_SIGNAL_KEY_BYTES
			) {
				throw new Error("Signal key store capacity exceeded");
			}
		});
	}

	private clearSignalKeys(): void {
		this.transaction(() => this.db.run("DELETE FROM signal_keys"));
	}

	private transaction<T>(operation: () => T): T {
		this.assertOpen();
		const result = this.db.transaction(operation)();
		secureStateFiles(dirname(this.databasePath));
		return result;
	}

	private withFailure<T>(operation: ProviderStateFailureOperation, action: () => T): T {
		try {
			this.assertOpen();
			return action();
		} catch (error: unknown) {
			const failure = error instanceof Error ? error : new Error(String(error));
			try {
				this.onFailure?.(operation, failure);
			} catch {
				// Preserve the storage failure as the authoritative error.
			}
			throw failure;
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("provider state is closed");
	}
}

export class ProviderInboxCapacityError extends Error {
	constructor() {
		super("provider inbox capacity exceeded");
		this.name = "ProviderInboxCapacityError";
	}
}

class SQLiteRetryCounterCache implements CacheStore {
	constructor(private readonly providerState: SQLiteProviderState) {}

	get<T>(key: string): T | undefined {
		return this.providerState.getRetryCounter<T>(key);
	}

	set<T>(key: string, value: T): void {
		this.providerState.setRetryCounter(key, value);
	}

	del(key: string): void {
		this.providerState.deleteRetryCounter(key);
	}

	flushAll(): void {
		this.providerState.clearRetryCounters();
	}
}

function configureDatabase(db: Database): void {
	db.exec("PRAGMA busy_timeout = 0");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = FULL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA trusted_schema = OFF");
	db.exec("PRAGMA locking_mode = EXCLUSIVE");
	db.exec("BEGIN EXCLUSIVE; COMMIT");
	const journalMode = db
		.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
		.get()?.journal_mode;
	const synchronous = db
		.query<{ synchronous: number }, []>("PRAGMA synchronous")
		.get()?.synchronous;
	const lockingMode = db
		.query<{ locking_mode: string }, []>("PRAGMA locking_mode")
		.get()?.locking_mode;
	if (journalMode !== "wal" || synchronous !== 2 || lockingMode !== "exclusive") {
		throw new Error("provider SQLite state cannot guarantee required durability and ownership");
	}
}

function createSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS provider_metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS auth_creds (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS signal_keys (
			category TEXT NOT NULL,
			key_id TEXT NOT NULL,
			value TEXT NOT NULL,
			byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
			PRIMARY KEY (category, key_id)
		);
		CREATE TABLE IF NOT EXISTS retry_cache (
			cache_key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
			expires_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS retry_messages (
			remote_jid TEXT NOT NULL,
			message_id TEXT NOT NULL,
			message BLOB NOT NULL,
			byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
			expires_at INTEGER NOT NULL,
			PRIMARY KEY (remote_jid, message_id)
		);
		CREATE TABLE IF NOT EXISTS provider_inbox (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			event_json TEXT NOT NULL,
			byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
			created_at INTEGER NOT NULL
		);
	`);
}

function validateOrBindMetadata(
	db: Database,
	input: { sessionId: string; webVersion: WAVersion; databaseExisted: boolean },
): void {
	if (input.webVersion.join(".") !== AUDITED_WHATSAPP_WEB_VERSION_TEXT) {
		throw new Error("provider state requires the audited WhatsApp Web version");
	}
	const expectedIdentity = new Map<string, string>([
		["schema_version", STATE_SCHEMA_VERSION],
		// Keep the durable key for compatibility; its value is an opaque session UUID.
		["account_id", input.sessionId],
	]);
	const currentProvenance = [AUDITED_BAILEYS_RELEASE, input.webVersion.join(".")] as const;
	if (!input.databaseExisted) {
		const insert = db.query("INSERT INTO provider_metadata (key, value) VALUES (?, ?)");
		for (const [key, value] of expectedIdentity) insert.run(key, value);
		insert.run("baileys_release", currentProvenance[0]);
		insert.run("whatsapp_web_version", currentProvenance[1]);
		return;
	}
	const rows = db
		.query<{ key: string; value: string }, []>("SELECT key, value FROM provider_metadata")
		.all();
	if (rows.length !== 4) {
		throw new Error("provider state metadata requires an explicit audited state migration");
	}
	const actual = new Map(rows.map((row) => [row.key, row.value]));
	for (const [key, value] of expectedIdentity) {
		if (actual.get(key) === value) continue;
		if (key === "account_id") {
			throw new Error("provider state is immutably bound to a different account id");
		}
		throw new Error("provider state metadata requires an explicit audited state migration");
	}
	const provenance = [actual.get("baileys_release"), actual.get("whatsapp_web_version")];
	const auditedProvenance = [["7.0.0-rc13", "2.3000.1035194821"], currentProvenance] as const;
	if (
		!auditedProvenance.some(([release, web]) => provenance[0] === release && provenance[1] === web)
	) {
		throw new Error("provider state metadata requires an explicit audited state migration");
	}
}

function assertDatabaseIntegrity(db: Database): void {
	const rows = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
	if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
		throw new Error("provider SQLite state failed integrity validation");
	}
}

function validatePendingProviderEvents(db: Database, inboxConfig: ProviderInboxConfig): void {
	const rows = db
		.query<{ sequence: number; event_json: string; byte_count: number }, []>(
			"SELECT sequence, event_json, byte_count FROM provider_inbox ORDER BY sequence",
		)
		.all();
	for (const row of rows) {
		if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) {
			throw new Error("provider inbox sequence is corrupt");
		}
		if (Buffer.byteLength(row.event_json) !== row.byte_count) {
			throw new Error("provider inbox event byte count is corrupt");
		}
		parseProviderMessageEvent(row.event_json, row.sequence);
	}
	const totals = providerInboxTotals(db);
	if (totals.eventCount > inboxConfig.maxEvents || totals.byteCount > inboxConfig.maxBytes) {
		throw new ProviderInboxCapacityError();
	}
}

function providerInboxTotals(db: Database): { eventCount: number; byteCount: number } {
	const totals = db
		.query<{ event_count: number; byte_count: number }, []>(
			`SELECT COUNT(*) AS event_count,
			 COALESCE(SUM(byte_count), 0) AS byte_count FROM provider_inbox`,
		)
		.get();
	if (!totals) throw new Error("provider inbox totals are unavailable");
	return { eventCount: totals.event_count, byteCount: totals.byte_count };
}

function assertStoredTextBytes(
	value: string,
	byteCount: number,
	maximum: number,
	label: string,
): void {
	const actual = Buffer.byteLength(value);
	if (actual !== byteCount || actual > maximum) {
		throw new Error(`corrupt ${label} byte count`);
	}
}

function assertStoredBytes(
	value: Uint8Array,
	byteCount: number,
	maximum: number,
	label: string,
): void {
	if (value.byteLength !== byteCount || value.byteLength > maximum) {
		throw new Error(`corrupt ${label} byte count`);
	}
}

function validateAuthenticationCreds(value: unknown): AuthenticationCreds {
	if (
		!isRecord(value) ||
		typeof value.registered !== "boolean" ||
		!validKeyPair(value.noiseKey) ||
		!validKeyPair(value.pairingEphemeralKeyPair) ||
		!validKeyPair(value.signedIdentityKey) ||
		!validSignedKeyPair(value.signedPreKey) ||
		!Number.isSafeInteger(value.registrationId) ||
		typeof value.registrationId !== "number" ||
		value.registrationId < 0 ||
		(value.registered &&
			(!isRecord(value.me) ||
				typeof value.me.id !== "string" ||
				!value.me.id ||
				value.me.id.length > 512)) ||
		!validBase64(value.advSecretKey) ||
		!Array.isArray(value.processedHistoryMessages) ||
		!nonNegativeSafeInteger(value.firstUnuploadedPreKeyId) ||
		!nonNegativeSafeInteger(value.nextPreKeyId) ||
		!nonNegativeSafeInteger(value.accountSyncCounter) ||
		!isRecord(value.accountSettings) ||
		typeof value.accountSettings.unarchiveChats !== "boolean" ||
		(value.pairingCode !== undefined && typeof value.pairingCode !== "string") ||
		(value.lastPropHash !== undefined && typeof value.lastPropHash !== "string") ||
		(value.routingInfo !== undefined && !isByteArray(value.routingInfo))
	) {
		throw new Error("corrupt Baileys authentication credentials");
	}
	return value as AuthenticationCreds;
}

function credentialsForPersistence(creds: AuthenticationCreds): AuthenticationCreds {
	return {
		...creds,
		// The link code is useful only to the live pairing socket and must never
		// survive in the physical auth database.
		pairingCode: undefined,
		// requestPairingCode temporarily stores the raw phone JID in `me` before
		// authentication. Retain it only with the complete identity evidence that
		// rc14 produces after it verifies a successful pairing.
		...(isLinkedAuthenticationCreds(creds) ? {} : { me: undefined }),
	};
}

export function isLinkedAuthenticationCreds(creds: AuthenticationCreds): boolean {
	if (creds.registered) return true;
	return (
		validContactIdentity(creds.me) &&
		validSignedDeviceIdentity(creds.account) &&
		Array.isArray(creds.signalIdentities) &&
		creds.signalIdentities.length > 0 &&
		creds.signalIdentities.every(validSignalIdentity)
	);
}

function validContactIdentity(value: unknown): boolean {
	return isRecord(value) && validIdentityJid(value.id);
}

function validSignedDeviceIdentity(value: unknown): boolean {
	return (
		isRecord(value) &&
		validNonemptyBytes(value.details) &&
		validNonemptyBytes(value.accountSignatureKey) &&
		validNonemptyBytes(value.accountSignature) &&
		validNonemptyBytes(value.deviceSignature)
	);
}

function validSignalIdentity(value: unknown): boolean {
	return (
		isRecord(value) &&
		isRecord(value.identifier) &&
		validIdentityJid(value.identifier.name) &&
		nonNegativeSafeInteger(value.identifier.deviceId) &&
		validNonemptyBytes(value.identifierKey)
	);
}

function validIdentityJid(value: unknown): boolean {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
	const separator = value.indexOf("@");
	if (separator < 1 || separator !== value.lastIndexOf("@")) return false;
	if (!/^[^@:\s]+(?::[0-9]+)?$/.test(value.slice(0, separator))) return false;
	const decoded = jidDecode(value);
	return (
		decoded !== undefined &&
		decoded.user.length > 0 &&
		["s.whatsapp.net", "lid", "hosted", "hosted.lid"].includes(decoded.server) &&
		(decoded.device === undefined || nonNegativeSafeInteger(decoded.device))
	);
}

function validNonemptyBytes(value: unknown): boolean {
	return isByteArray(value) && value.byteLength > 0;
}

function validKeyPair(value: unknown): boolean {
	return (
		isRecord(value) &&
		isByteArray(value.public) &&
		value.public.byteLength > 0 &&
		isByteArray(value.private) &&
		value.private.byteLength > 0
	);
}

function validSignedKeyPair(value: unknown): boolean {
	return (
		isRecord(value) &&
		validKeyPair(value.keyPair) &&
		isByteArray(value.signature) &&
		value.signature.byteLength > 0 &&
		nonNegativeSafeInteger(value.keyId)
	);
}

function nonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isByteArray(value: unknown): value is Uint8Array {
	return value instanceof Uint8Array;
}

function validateSessionId(value: string): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
		throw new Error("provider session id must be a canonical lowercase UUID");
	}
}

function validateSignalCategory(value: string): asserts value is keyof SignalDataTypeMap {
	if (!SIGNAL_CATEGORIES.has(value as keyof SignalDataTypeMap)) {
		throw new Error("unsupported Signal key category");
	}
}

function validateSignalKeyId(value: string): void {
	if (
		!value ||
		Buffer.byteLength(value) > MAX_SIGNAL_KEY_ID_BYTES ||
		hasAsciiControlCharacter(value)
	) {
		throw new Error("invalid Signal key id");
	}
}

function validateRetryCacheKey(value: string): void {
	if (!value || Buffer.byteLength(value) > MAX_RETRY_CACHE_KEY_BYTES) {
		throw new Error("invalid retry cache key");
	}
}

function validateRetryMessageIdentity(remoteJid: string, messageId: string): void {
	if (
		!validEventString(remoteJid) ||
		!validEventString(messageId) ||
		hasAsciiControlCharacter(remoteJid) ||
		hasAsciiControlCharacter(messageId)
	) {
		throw new Error("invalid retry message identity");
	}
}

function validateInboxConfig(config: ProviderInboxConfig): void {
	if (!Number.isSafeInteger(config.maxEvents) || config.maxEvents < 1) {
		throw new Error("provider inbox maxEvents must be positive");
	}
	if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1) {
		throw new Error("provider inbox maxBytes must be positive");
	}
}

function validateProviderMessageEventInput(value: ProviderMessageEventInput): void {
	if (
		value.eventType !== "messages.upsert" ||
		value.fromMe !== false ||
		!validEventString(value.messageId) ||
		!validEventString(value.remoteJid) ||
		!validBase64(value.messageProtoBase64) ||
		(value.messageTimestamp !== undefined &&
			(!Number.isSafeInteger(value.messageTimestamp) || value.messageTimestamp < 1))
	) {
		throw new Error("invalid provider inbox event");
	}
	for (const optional of [
		value.remoteJidAlt,
		value.participant,
		value.participantAlt,
		value.pushName,
	]) {
		if (optional !== undefined && !validEventString(optional)) {
			throw new Error("invalid provider inbox event string");
		}
	}
}

function parseProviderMessageEvent(value: string, sequence: number): ProviderMessageEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error: unknown) {
		throw new Error(
			`corrupt provider inbox event ${sequence}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (!isRecord(parsed)) throw new Error(`corrupt provider inbox event ${sequence}`);
	const event: ProviderMessageEventInput = {
		eventType: parsed.eventType === "messages.upsert" ? parsed.eventType : "messages.upsert",
		messageId: typeof parsed.messageId === "string" ? parsed.messageId : "",
		remoteJid: typeof parsed.remoteJid === "string" ? parsed.remoteJid : "",
		fromMe: false,
		messageProtoBase64:
			typeof parsed.messageProtoBase64 === "string" ? parsed.messageProtoBase64 : "",
		...(typeof parsed.remoteJidAlt === "string" ? { remoteJidAlt: parsed.remoteJidAlt } : {}),
		...(typeof parsed.participant === "string" ? { participant: parsed.participant } : {}),
		...(typeof parsed.participantAlt === "string" ? { participantAlt: parsed.participantAlt } : {}),
		...(typeof parsed.pushName === "string" ? { pushName: parsed.pushName } : {}),
		...(typeof parsed.messageTimestamp === "number"
			? { messageTimestamp: parsed.messageTimestamp }
			: {}),
	};
	if (parsed.fromMe !== false || parsed.eventType !== "messages.upsert") {
		throw new Error(`corrupt provider inbox event ${sequence}`);
	}
	validateProviderMessageEventInput(event);
	return { sequence, ...event };
}

function serializeBufferJson(value: unknown, label: string): string {
	const serialized = JSON.stringify(value, BufferJSON.replacer);
	if (typeof serialized !== "string") throw new Error(`${label} is not serializable`);
	return serialized;
}

function parseBufferJson<T = unknown>(value: string, label: string): T {
	try {
		return JSON.parse(value, BufferJSON.reviver) as T;
	} catch (error: unknown) {
		throw new Error(`corrupt ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("corrupt app-state-sync-key value");
	return value;
}

function validEventString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function hasAsciiControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => character.charCodeAt(0) < 0x20);
}

function validBase64(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4 * 1024 * 1024) {
		return false;
	}
	try {
		const decoded = Buffer.from(value, "base64");
		return decoded.length > 0 && decoded.toString("base64") === value;
	} catch {
		return false;
	}
}

function prepareSessionDirectory(sessionDir: string): void {
	assertOwnedDirectory(sessionDir, 0o700, "provider session directory");
}

function rejectLegacyState(sessionDir: string): void {
	for (const entry of readdirSync(sessionDir)) {
		if (LEGACY_STATE_NAMES.has(entry) || entry.endsWith(".json")) {
			throw new Error(
				"legacy provider state requires an explicit complete migration before SQLite startup",
			);
		}
	}
}

function secureStateFiles(sessionDir: string): void {
	for (const name of [
		STATE_DATABASE_FILE,
		`${STATE_DATABASE_FILE}-wal`,
		`${STATE_DATABASE_FILE}-shm`,
	]) {
		const path = join(sessionDir, name);
		if (!existsSync(path)) continue;
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error(`provider state path must be a regular file: ${name}`);
		}
		chmodSync(path, 0o600);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const AUDITED_PROVIDER_STATE_METADATA = {
	schemaVersion: STATE_SCHEMA_VERSION,
	baileysRelease: AUDITED_BAILEYS_RELEASE,
	whatsappWebVersion: AUDITED_WHATSAPP_WEB_VERSION_TEXT,
} as const;
