import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthenticationCreds, BufferJSON, proto } from "baileys";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseAuditedWhatsAppWebVersion } from "./audited-version.js";
import { Database } from "./sqlite-database.js";
import {
	isLinkedAuthenticationCreds,
	ProviderInboxCapacityError,
	type ProviderMessageEventInput,
	type ProviderStateFailureOperation,
	SQLiteProviderState,
} from "./sqlite-state.js";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const REGISTERED_ME = { id: "15550001111:1@s.whatsapp.net", name: "Test account" };
const WEB_VERSION = parseAuditedWhatsAppWebVersion("2.3000.1043857760");
const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const directory of temporaryDirectories.splice(0)) {
		try {
			const database = new Database(join(directory, "provider-state.sqlite"));
			database.close();
		} catch {
			// The database may not exist or may intentionally be corrupt.
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("SQLite provider state", () => {
	it("round-trips verified rc14 QR creds, Signal state, and retries across restart", async () => {
		const directory = makeDirectory();
		const first = makeState(directory);
		first.saveCreds({
			...verifiedQrUpdate(),
			registrationId: 0,
			routingInfo: Buffer.from([1, 2, 3]),
		});
		expect(first.state.creds.registered).toBe(false);
		expect(isLinkedAuthenticationCreds(first.state.creds)).toBe(true);
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
		expect(second.state.creds.registrationId).toBe(0);
		expect(second.state.creds.registered).toBe(false);
		expect(second.state.creds.me).toEqual({
			...REGISTERED_ME,
			lid: "15550001111@lid",
		});
		expect(isLinkedAuthenticationCreds(second.state.creds)).toBe(true);
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

	it("recovers the existing rc14 protobuf JSON identity and rewrites it as durable bytes", async () => {
		const directory = makeDirectory();
		const first = makeState(directory);
		const signalSessions = Object.fromEntries(
			Array.from({ length: 822 }, (_, index) => [
				`session-${index}`,
				Buffer.from([(index % 251) + 1]),
			]),
		);
		await first.state.keys.set({ session: signalSessions });
		const existingValue = storedLinkedCreds(first, protobufSignedDeviceIdentity());
		expect(JSON.parse(existingValue)).toMatchObject({
			registered: false,
			account: {
				details: "AQ==",
				accountSignatureKey: "Ag==",
				accountSignature: "Aw==",
				deviceSignature: "BA==",
			},
		});
		first.close();
		mutateDatabase(directory, (database) => {
			database.query("UPDATE auth_creds SET value = ? WHERE singleton = 1").run(existingValue);
		});

		const second = makeState(directory);
		expect(second.state.creds.registered).toBe(false);
		expect(second.state.creds.me).toEqual({
			...REGISTERED_ME,
			lid: "15550001111@lid",
		});
		expect(second.state.creds.account).toEqual({
			details: Buffer.from([1]),
			accountSignatureKey: Buffer.from([2]),
			accountSignature: Buffer.from([3]),
			deviceSignature: Buffer.from([4]),
		});
		expect(second.state.creds.signalIdentities?.[0]?.identifierKey).toEqual(Buffer.from([5]));
		expect(isLinkedAuthenticationCreds(second.state.creds)).toBe(true);
		expect(
			internalDatabase(second)
				.query<{ key_count: number }, []>("SELECT COUNT(*) AS key_count FROM signal_keys")
				.get(),
		).toEqual({ key_count: 822 });
		expect(second.physicalAuthQuarantineReason()).toBeUndefined();

		second.saveCreds();
		const rewritten = internalDatabase(second)
			.query<{ value: string }, []>("SELECT value FROM auth_creds WHERE singleton = 1")
			.get();
		expect(rewritten).toBeDefined();
		expect(JSON.parse(rewritten?.value ?? "null")).toMatchObject({
			registered: false,
			account: {
				details: { type: "Buffer", data: "AQ==" },
				accountSignatureKey: { type: "Buffer", data: "Ag==" },
				accountSignature: { type: "Buffer", data: "Aw==" },
				deviceSignature: { type: "Buffer", data: "BA==" },
			},
		});
		second.close();

		const third = makeState(directory);
		expect(third.state.creds.registered).toBe(false);
		expect(isLinkedAuthenticationCreds(third.state.creds)).toBe(true);
		expect(third.state.creds.account?.details).toEqual(Buffer.from([1]));
		third.close();
	});

	it.each([
		[
			"empty",
			{
				details: "",
				accountSignatureKey: "Ag==",
				accountSignature: "Aw==",
				deviceSignature: "BA==",
			},
		],
		[
			"noncanonical",
			{
				details: "AQ",
				accountSignatureKey: "Ag==",
				accountSignature: "Aw==",
				deviceSignature: "BA==",
			},
		],
		[
			"malformed",
			{
				details: "%%%%",
				accountSignatureKey: "Ag==",
				accountSignature: "Aw==",
				deviceSignature: "BA==",
			},
		],
		[
			"oversized",
			{
				details: Buffer.alloc(1024 * 1024 + 1, 1).toString("base64"),
				accountSignatureKey: "Ag==",
				accountSignature: "Aw==",
				deviceSignature: "BA==",
			},
		],
		["partial", { details: "AQ==", accountSignatureKey: "Ag==", accountSignature: "Aw==" }],
	])("rejects a %s persisted signed-device identity", (_label, account) => {
		const directory = makeDirectory();
		const first = makeState(directory);
		const stored = storedLinkedCreds(first, account);
		first.close();
		mutateDatabase(directory, (database) => {
			database.query("UPDATE auth_creds SET value = ? WHERE singleton = 1").run(stored);
		});

		const second = makeState(directory);
		expect(second.state.creds.registered).toBe(false);
		expect(isLinkedAuthenticationCreds(second.state.creds)).toBe(false);
		second.saveCreds();
		second.close();

		const third = makeState(directory);
		expect(third.state.creds.me).toBeUndefined();
		expect(isLinkedAuthenticationCreds(third.state.creds)).toBe(false);
		third.close();
	});

	it("keeps temporary pairing-code and malformed identity input unlinked and out of snapshots", () => {
		const directory = makeDirectory();
		const phoneJid = "14155550123@s.whatsapp.net";
		const first = makeState(directory);
		first.saveCreds({
			me: { id: phoneJid, name: "~" },
			pairingCode: "12345678",
			account: verifiedQrUpdate().account,
			signalIdentities: [
				{
					identifier: { name: "", deviceId: -1 },
					identifierKey: Buffer.alloc(0),
				},
			],
		});

		expect(first.state.creds.me?.id).toBe(phoneJid);
		expect(first.state.creds.pairingCode).toBe("12345678");
		expect(isLinkedAuthenticationCreds(first.state.creds)).toBe(false);
		const stored = internalDatabase(first)
			.query<{ value: string }, []>("SELECT value FROM auth_creds WHERE singleton = 1")
			.get();
		expect(stored?.value).not.toContain(phoneJid);
		expect(stored?.value).not.toContain("12345678");
		first.close();

		const second = makeState(directory);
		expect(second.state.creds.me).toBeUndefined();
		expect(second.state.creds.pairingCode).toBeUndefined();
		expect(isLinkedAuthenticationCreds(second.state.creds)).toBe(false);
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

	it("returns pending provider events without waiting", async () => {
		const state = makeState(makeDirectory());
		state.appendProviderEvents([providerEvent("pending")]);

		expect(await state.waitForProviderEvents(100, 8_000)).toEqual(state.providerEvents(100));
		state.close();
	});

	it("wakes every provider event waiter when events are appended", async () => {
		const state = makeState(makeDirectory());
		const first = state.waitForProviderEvents(100, 8_000);
		const second = state.waitForProviderEvents(100, 8_000);

		state.appendProviderEvents([providerEvent("appended")]);

		const results = await Promise.all([first, second]);
		expect(results.map((events) => events.map((event) => event.messageId))).toEqual([
			["appended"],
			["appended"],
		]);
		state.close();
	});

	it("returns an empty provider event batch when the wait expires", async () => {
		vi.useFakeTimers();
		const state = makeState(makeDirectory());
		const waiting = state.waitForProviderEvents(100, 8_000);

		await vi.advanceTimersByTimeAsync(8_000);

		await expect(waiting).resolves.toEqual([]);
		state.close();
	});

	it("resolves provider event waiters when the state closes", async () => {
		const state = makeState(makeDirectory());
		const waiting = state.waitForProviderEvents(100, 8_000);

		state.close();

		await expect(waiting).resolves.toEqual([]);
	});

	it("atomically clears physical auth, Signal, retry, and inbox state across restart", async () => {
		const directory = makeDirectory();
		let first: SQLiteProviderState | undefined = makeState(directory);
		first.saveCreds({ registered: true, me: REGISTERED_ME, routingInfo: Buffer.from([1, 2, 3]) });
		await first.state.keys.set({ session: { sender: Buffer.from([4, 5, 6]) } });
		first.retryCounterCache.set("retry", { count: 2 });
		first.storeRetryMessage(
			"15550001111@s.whatsapp.net",
			"outbound-1",
			proto.Message.encode({ conversation: "retry" }).finish(),
		);
		first.appendProviderEvents([providerEvent("inbound-1")]);

		first.resetPhysicalAuth();

		expect(first.state.creds.registered).toBe(false);
		expect(await first.state.keys.get("session", ["sender"])).toEqual({});
		expect(first.retryCounterCache.get("retry")).toBeUndefined();
		expect(first.getRetryMessage("15550001111@s.whatsapp.net", "outbound-1")).toBeUndefined();
		expect(first.providerEvents(100)).toEqual([]);
		first.close();
		first = undefined;
		globalThis.gc?.();

		const second = makeState(directory);
		expect(second.state.creds.registered).toBe(false);
		expect(await second.state.keys.get("session", ["sender"])).toEqual({});
		expect(second.retryCounterCache.get("retry")).toBeUndefined();
		expect(second.getRetryMessage("15550001111@s.whatsapp.net", "outbound-1")).toBeUndefined();
		expect(second.providerEvents(100)).toEqual([]);
		second.close();
	});

	it("persists physical-auth quarantine and clears it only with explicit auth reset", () => {
		const directory = makeDirectory();
		const first = makeState(directory);
		first.saveCreds({ registered: true, me: REGISTERED_ME });
		first.quarantinePhysicalAuth("remote_logged_out");
		expect(first.physicalAuthQuarantineReason()).toBe("remote_logged_out");
		first.close();

		const second = makeState(directory);
		expect(second.state.creds.registered).toBe(true);
		expect(second.physicalAuthQuarantineReason()).toBe("remote_logged_out");
		second.resetPhysicalAuth();
		expect(second.physicalAuthQuarantineReason()).toBeUndefined();
		second.close();

		const third = makeState(directory);
		expect(third.state.creds.registered).toBe(false);
		expect(third.physicalAuthQuarantineReason()).toBeUndefined();
		third.close();
	});

	it("rolls back and reports a failed physical-auth reset", async () => {
		const failures: ProviderStateFailureOperation[] = [];
		const state = makeState(makeDirectory(), {
			onFailure: (operation) => failures.push(operation),
		});
		state.saveCreds({ registered: true, me: REGISTERED_ME });
		state.quarantinePhysicalAuth("remote_logged_out");
		await state.state.keys.set({ session: { sender: Buffer.from([1]) } });
		internalDatabase(state).exec(`
			CREATE TRIGGER fail_auth_reset BEFORE INSERT ON auth_creds
			BEGIN SELECT RAISE(ABORT, 'injected auth reset failure'); END;
		`);

		expect(() => state.resetPhysicalAuth()).toThrow("injected auth reset failure");
		expect(state.state.creds.registered).toBe(true);
		expect(state.physicalAuthQuarantineReason()).toBe("remote_logged_out");
		expect(await state.state.keys.get("session", ["sender"])).toEqual({
			sender: Buffer.from([1]),
		});
		expect(failures).toEqual(["physical_auth_reset"]);
		state.close();
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
		const missingIdentityState = makeState(makeDirectory());
		expect(() => missingIdentityState.saveCreds({ registered: true })).toThrow(
			"corrupt Baileys authentication credentials",
		);
		missingIdentityState.close();

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

	it("accepts only exact audited state provenance without rewriting rc13 metadata", async () => {
		const directory = makeDirectory();
		const first = makeState(directory);
		first.saveCreds({ registered: true, me: REGISTERED_ME, routingInfo: Buffer.from([1, 2, 3]) });
		await first.state.keys.set({
			session: { sender: Buffer.from([4, 5, 6]) },
			tctoken: { contact: { token: Buffer.from([7, 8]), timestamp: "1700000000" } },
		});
		first.retryCounterCache.set("retry", { count: 2 });
		first.appendProviderEvents([providerEvent("inbound-1")]);
		first.close();
		mutateDatabase(directory, (database) => {
			const update = database.query("UPDATE provider_metadata SET value = ? WHERE key = ?");
			update.run("7.0.0-rc13", "baileys_release");
			update.run("2.3000.1035194821", "whatsapp_web_version");
		});

		const reopened = makeState(directory);
		expect(reopened.state.creds.routingInfo).toEqual(Buffer.from([1, 2, 3]));
		expect(await reopened.state.keys.get("session", ["sender"])).toEqual({
			sender: Buffer.from([4, 5, 6]),
		});
		expect(await reopened.state.keys.get("tctoken", ["contact"])).toEqual({
			contact: { token: Buffer.from([7, 8]), timestamp: "1700000000" },
		});
		expect(reopened.retryCounterCache.get<{ count: number }>("retry")).toEqual({ count: 2 });
		expect(reopened.providerEvents(100)).toHaveLength(1);
		const metadata = internalDatabase(reopened)
			.query<{ key: string; value: string }, []>("SELECT key, value FROM provider_metadata")
			.all();
		expect(Object.fromEntries(metadata.map((row) => [row.key, row.value]))).toMatchObject({
			baileys_release: "7.0.0-rc13",
			whatsapp_web_version: "2.3000.1035194821",
		});
		reopened.close();

		expect(() => makeState(directory, { sessionId: ACCOUNT_B })).toThrow(
			"immutably bound to a different account id",
		);

		mutateDatabase(directory, (database) => {
			database
				.query("UPDATE provider_metadata SET value = '2.3000.999' WHERE key = ?")
				.run("whatsapp_web_version");
		});
		expect(() => makeState(directory)).toThrow("explicit audited state migration");
	});

	it("records rc14 provenance for a new database and rejects mixed or extra metadata", () => {
		const directory = makeDirectory();
		const state = makeState(directory);
		state.close();
		mutateDatabase(directory, (database) => {
			const rows = database
				.query<{ key: string; value: string }, []>("SELECT key, value FROM provider_metadata")
				.all();
			expect(Object.fromEntries(rows.map((row) => [row.key, row.value]))).toMatchObject({
				baileys_release: "7.0.0-rc14",
				whatsapp_web_version: "2.3000.1043857760",
			});
			database
				.query("UPDATE provider_metadata SET value = ? WHERE key = 'baileys_release'")
				.run("7.0.0-rc13");
		});
		expect(() => makeState(directory)).toThrow("explicit audited state migration");

		mutateDatabase(directory, (database) => {
			database
				.query("UPDATE provider_metadata SET value = ? WHERE key = 'baileys_release'")
				.run("7.0.0-rc14");
			database.query("INSERT INTO provider_metadata (key, value) VALUES ('unexpected', '1')").run();
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

	it("rejects an unsafe state-directory mode without repairing it", () => {
		const directory = makeDirectory();
		chmodSync(directory, 0o755);
		expect(() => makeState(directory)).toThrow("provider session directory must have mode 700");
		expect(statSync(directory).mode & 0o777).toBe(0o755);
		chmodSync(directory, 0o700);
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
		sessionId?: string;
		maxEvents?: number;
		maxBytes?: number;
		onFailure?: (operation: ProviderStateFailureOperation, error: Error) => void;
	} = {},
): SQLiteProviderState {
	return new SQLiteProviderState(
		directory,
		options.sessionId ?? ACCOUNT_A,
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

function verifiedQrUpdate(): Partial<AuthenticationCreds> {
	return {
		account: {
			details: Buffer.from([1]),
			accountSignatureKey: Buffer.from([2]),
			accountSignature: Buffer.from([3]),
			deviceSignature: Buffer.from([4]),
		},
		me: { ...REGISTERED_ME, lid: "15550001111@lid" },
		signalIdentities: [
			{
				identifier: { name: "15550001111@lid", deviceId: 0 },
				identifierKey: Buffer.from([5]),
			},
		],
	};
}

function protobufSignedDeviceIdentity(): proto.ADVSignedDeviceIdentity {
	return proto.ADVSignedDeviceIdentity.create({
		details: Buffer.from([1]),
		accountSignatureKey: Buffer.from([2]),
		accountSignature: Buffer.from([3]),
		deviceSignature: Buffer.from([4]),
	});
}

function storedLinkedCreds(state: SQLiteProviderState, account: unknown): string {
	const serialized = JSON.stringify(
		{
			...state.state.creds,
			...verifiedQrUpdate(),
			account,
			registered: false,
		},
		BufferJSON.replacer,
	);
	if (typeof serialized !== "string") throw new Error("test credentials are not serializable");
	return serialized;
}

function internalDatabase(state: SQLiteProviderState): Database {
	const value: unknown = Reflect.get(state, "db");
	if (!(value instanceof Database)) throw new Error("SQLite provider state database unavailable");
	return value;
}

function mutateDatabase(directory: string, action: (database: Database) => void): void {
	const database = new Database(join(directory, "provider-state.sqlite"));
	try {
		action(database);
	} finally {
		database.close();
	}
}
