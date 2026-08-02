import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";

import { parseAuditedWhatsAppWebVersion } from "./audited-version.js";
import {
	ProviderInboxCapacityError,
	type ProviderMessageEventInput,
	type ProviderStateFailureOperation,
	SQLiteProviderState,
} from "./sqlite-state.js";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const WEB_VERSION = parseAuditedWhatsAppWebVersion("2.3000.1035194821");
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		try {
			const database = new Database(join(directory, "provider-state.sqlite"), { strict: true });
			database.close();
		} catch {
			// The database may not exist or may intentionally be corrupt.
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("SQLite provider state", () => {
	it("round-trips creds, Signal keys, app-state proto, retries, and clears across restart", async () => {
		const directory = makeDirectory();
		const first = makeState(directory);
		first.saveCreds({ registered: true, routingInfo: Buffer.from([1, 2, 3]) });
		const appStateKey = proto.Message.AppStateSyncKeyData.create({
			keyData: Buffer.from([9, 8, 7]),
			fingerprint: { rawId: 4, currentIndex: 2, deviceIndexes: [0, 1] },
		});
		await first.state.keys.set({
			"pre-key": {
				one: { public: Buffer.from([1, 2]), private: Buffer.from([3, 4]) },
			},
			session: { two: Buffer.from([5, 6]) },
			"app-state-sync-key": { three: appStateKey },
		});
		first.retryCounterCache.set("retry", { count: 3, bytes: Buffer.from([7]) });
		const messageBytes = proto.Message.encode({ conversation: "durable" }).finish();
		first.storeRetryMessage("15550001111@s.whatsapp.net", "message-1", messageBytes);
		first.close();

		const second = makeState(directory);
		expect(second.state.creds.registered).toBe(true);
		expect(second.state.creds.routingInfo).toEqual(Buffer.from([1, 2, 3]));
		expect(await second.state.keys.get("pre-key", ["one"])).toEqual({
			one: { public: Buffer.from([1, 2]), private: Buffer.from([3, 4]) },
		});
		expect(await second.state.keys.get("session", ["two", "missing"])).toEqual({
			two: Buffer.from([5, 6]),
		});
		const restoredAppState = await second.state.keys.get("app-state-sync-key", ["three"]);
		expect(restoredAppState.three).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
		expect(restoredAppState.three?.keyData).toEqual(Buffer.from([9, 8, 7]));
		expect(second.retryCounterCache.get<{ count: number; bytes: Buffer }>("retry")).toEqual({
			count: 3,
			bytes: Buffer.from([7]),
		});
		expect(second.getRetryMessage("15550001111@s.whatsapp.net", "message-1")).toEqual({
			conversation: "durable",
		});

		await second.state.keys.set({ session: { two: null } });
		expect(await second.state.keys.get("session", ["two"])).toEqual({});
		await second.state.keys.clear?.();
		expect(await second.state.keys.get("pre-key", ["one"])).toEqual({});
		second.retryCounterCache.del("retry");
		expect(second.retryCounterCache.get("retry")).toBeUndefined();
		second.close();
	});

	it("rolls back a multi-key Signal transaction and reports the injected failure", async () => {
		const failures: Array<{ operation: ProviderStateFailureOperation; message: string }> = [];
		const state = makeState(makeDirectory(), {
			onFailure: (operation, error) => failures.push({ operation, message: error.message }),
		});
		const database = internalDatabase(state);
		database.exec(`
			CREATE TRIGGER fail_signal_key BEFORE INSERT ON signal_keys
			WHEN NEW.key_id = 'second'
			BEGIN SELECT RAISE(ABORT, 'injected signal failure'); END;
		`);

		await expect(
			state.state.keys.set({
				session: { first: Buffer.from([1]), second: Buffer.from([2]) },
			}),
		).rejects.toThrow("injected signal failure");
		expect(await state.state.keys.get("session", ["first", "second"])).toEqual({});
		expect(failures).toEqual([
			{ operation: "signal_key_write", message: "injected signal failure" },
		]);
		state.close();
	});

	it("keeps inbox sequence monotonic after every event is committed and acknowledged", () => {
		const directory = makeDirectory();
		const first = makeState(directory);
		first.appendProviderEvents([providerEvent("first")]);
		expect(first.providerEvents(100)[0]?.sequence).toBe(1);
		first.acknowledgeProviderEvents(1);
		expect(first.providerEvents(100)).toEqual([]);
		first.close();

		const second = makeState(directory);
		second.appendProviderEvents([providerEvent("second")]);
		expect(second.providerEvents(100)[0]?.sequence).toBe(2);
		second.close();
	});

	it("enforces inbox event and byte capacities atomically", () => {
		const countState = makeState(makeDirectory(), { maxEvents: 1, maxBytes: 100_000 });
		countState.appendProviderEvents([providerEvent("first")]);
		expect(() => countState.appendProviderEvents([providerEvent("second")])).toThrow(
			ProviderInboxCapacityError,
		);
		expect(countState.providerEvents(100).map((event) => event.messageId)).toEqual(["first"]);
		countState.close();

		const byteState = makeState(makeDirectory(), { maxEvents: 10, maxBytes: 32 });
		expect(() => byteState.appendProviderEvents([providerEvent("too-large")])).toThrow(
			ProviderInboxCapacityError,
		);
		expect(byteState.providerEvents(100)).toEqual([]);
		byteState.close();
	});

	it("reports an injected inbox transaction failure without retaining a partial batch", () => {
		const failures: ProviderStateFailureOperation[] = [];
		const state = makeState(makeDirectory(), {
			onFailure: (operation) => failures.push(operation),
		});
		internalDatabase(state).exec(`
			CREATE TRIGGER fail_provider_event BEFORE INSERT ON provider_inbox
			WHEN NEW.event_json LIKE '%second%'
			BEGIN SELECT RAISE(ABORT, 'injected inbox failure'); END;
		`);

		expect(() =>
			state.appendProviderEvents([providerEvent("first"), providerEvent("second")]),
		).toThrow("injected inbox failure");
		expect(state.providerEvents(100)).toEqual([]);
		expect(failures).toEqual(["provider_inbox_write"]);
		state.close();
	});

	it("fails closed on corrupt creds and corrupt pending inbox data", () => {
		const credsDirectory = makeDirectory();
		const credsState = makeState(credsDirectory);
		credsState.close();
		mutateDatabase(credsDirectory, (database) => {
			database.query("UPDATE auth_creds SET value = ? WHERE singleton = 1").run("not-json");
		});
		expect(() => makeState(credsDirectory)).toThrow("corrupt auth credentials");

		const inboxDirectory = makeDirectory();
		const inboxState = makeState(inboxDirectory);
		inboxState.appendProviderEvents([providerEvent("first")]);
		inboxState.close();
		mutateDatabase(inboxDirectory, (database) => {
			database
				.query("UPDATE provider_inbox SET event_json = ?, byte_count = ? WHERE sequence = 1")
				.run("{}", 2);
		});
		expect(() => makeState(inboxDirectory)).toThrow("corrupt provider inbox event");
	});

	it("immutably binds a session to one account and one audited state version", () => {
		const directory = makeDirectory();
		const first = makeState(directory);
		first.close();
		expect(() => makeState(directory, { accountId: ACCOUNT_B })).toThrow(
			"immutably bound to a different account id",
		);

		mutateDatabase(directory, (database) => {
			database
				.query("UPDATE provider_metadata SET value = '2.3000.999' WHERE key = ?")
				.run("whatsapp_web_version");
		});
		expect(() => makeState(directory)).toThrow("explicit audited state migration");
	});

	it("uses SQLite exclusive locking instead of PID-file stale-owner deletion", () => {
		const directory = makeDirectory();
		const first = makeState(directory);
		const database = internalDatabase(first);
		expect(database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "wal",
		});
		expect(database.query<{ synchronous: number }, []>("PRAGMA synchronous").get()).toEqual({
			synchronous: 2,
		});
		expect(database.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get()).toEqual({
			locking_mode: "exclusive",
		});
		expect(() => makeState(directory)).toThrow();
		first.close();
		const reopened = makeState(directory);
		reopened.close();
	});

	it("rejects legacy state and protects database files", () => {
		const legacyDirectory = makeDirectory();
		writeFileSync(join(legacyDirectory, "creds.json"), "{}");
		expect(() => makeState(legacyDirectory)).toThrow("explicit complete migration");

		const directory = makeDirectory();
		const state = makeState(directory);
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(state.databasePath).mode & 0o777).toBe(0o600);
		state.close();
	});

	it("rejects a symlinked database before opening provider state", () => {
		const directory = makeDirectory();
		const target = join(directory, "unrelated-target");
		writeFileSync(target, "must-not-be-opened");
		symlinkSync(target, join(directory, "provider-state.sqlite"));

		expect(() => makeState(directory)).toThrow("provider state path must be a regular file");
		expect(readFileSync(target, "utf8")).toBe("must-not-be-opened");
	});
});

function makeDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "clawdi-wa-sqlite-state-"));
	temporaryDirectories.push(directory);
	return directory;
}

function makeState(
	directory: string,
	options: {
		accountId?: string;
		maxEvents?: number;
		maxBytes?: number;
		onFailure?: (operation: ProviderStateFailureOperation, error: Error) => void;
	} = {},
): SQLiteProviderState {
	return new SQLiteProviderState(
		directory,
		options.accountId ?? ACCOUNT_A,
		WEB_VERSION,
		{
			maxEvents: options.maxEvents ?? 100,
			maxBytes: options.maxBytes ?? 1024 * 1024,
		},
		options.onFailure,
	);
}

function providerEvent(messageId: string): ProviderMessageEventInput {
	return {
		eventType: "messages.upsert",
		messageId,
		remoteJid: "15550001111@s.whatsapp.net",
		fromMe: false,
		messageProtoBase64: Buffer.from(
			proto.Message.encode({ conversation: messageId }).finish(),
		).toString("base64"),
	};
}

function internalDatabase(state: SQLiteProviderState): Database {
	const value: unknown = Reflect.get(state, "db");
	if (!(value instanceof Database)) throw new Error("SQLite provider state database unavailable");
	return value;
}

function mutateDatabase(directory: string, action: (database: Database) => void): void {
	const database = new Database(join(directory, "provider-state.sqlite"), { strict: true });
	try {
		action(database);
	} finally {
		database.close();
	}
}
