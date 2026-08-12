import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuthenticationCreds,
	type BinaryNode,
	DisconnectReason,
	initAuthCreds,
	proto,
} from "baileys";
import { describe, expect, it } from "vitest";

import { parseAuditedWhatsAppWebVersion } from "./audited-version.js";
import type { SidecarSessionConfig } from "./config.js";
import { BaileysSocketRuntime, type ProviderSocketFactory } from "./runtime.js";
import type { ProviderMessageEventInput } from "./sqlite-state.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("physical Baileys runtime", () => {
	it("exposes only the authenticated durable user LID in health", async () => {
		const validHarness = createHarness({
			user: {
				id: "15550001111:1@s.whatsapp.net",
				name: "Test account",
				lid: "900000000000001:7@lid",
			},
		});
		const valid = new BaileysSocketRuntime(sidecarConfig(), validHarness.dependencies);
		expect(valid.health().user).toEqual({
			id: "15550001111:1@s.whatsapp.net",
			name: "Test account",
			lid: "900000000000001:7@lid",
		});

		const invalidHarness = createHarness({
			user: {
				id: "15550001111:1@s.whatsapp.net",
				name: "Test account",
				lid: "15550001111@s.whatsapp.net",
			},
		});
		const invalid = new BaileysSocketRuntime(sidecarConfig(), invalidHarness.dependencies);
		expect(invalid.health().user).toEqual({
			id: "15550001111:1@s.whatsapp.net",
			name: "Test account",
		});
		await valid.stop();
		await invalid.stop();
	});

	it("retains verified rc14 QR identity through restart and SQLite reopen", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-runtime-qr-"));
		const config = { ...sidecarConfig(), sessionDir };
		const harness = createHarness({ registered: false });
		const runtime = new BaileysSocketRuntime(config, {
			socketFactory: harness.dependencies.socketFactory,
		});
		let reopenedRuntime: BaileysSocketRuntime | undefined;
		try {
			await runtime.start();
			expect(harness.socketConfigurations).toHaveLength(0);
			expect(runtime.health()).toMatchObject({ status: "stopped", registered: false });

			await runtime.startQrPairing();
			expect(harness.socketConfigurations).toHaveLength(1);
			const firstQrObservedAt = Date.now();
			harness.events.emit("connection.update", { qr: "sensitive-qr-value" });
			const ready = runtime.pairingStatus();
			expect(ready).toMatchObject({
				status: "pairing_qr",
				registered: false,
				method: "qr",
				qr: "sensitive-qr-value",
			});
			expect(Date.parse(ready.qrExpiresAt ?? "") - firstQrObservedAt).toBeGreaterThanOrEqual(
				59_000,
			);
			expect(Date.parse(ready.qrExpiresAt ?? "") - firstQrObservedAt).toBeLessThanOrEqual(61_000);
			const rotatedQrObservedAt = Date.now();
			harness.events.emit("connection.update", { qr: "sensitive-qr-value-rotated" });
			const rotated = runtime.pairingStatus();
			expect(rotated).toMatchObject({ qr: "sensitive-qr-value-rotated" });
			expect(Date.parse(rotated.qrExpiresAt ?? "") - rotatedQrObservedAt).toBeGreaterThanOrEqual(
				19_000,
			);
			expect(Date.parse(rotated.qrExpiresAt ?? "") - rotatedQrObservedAt).toBeLessThanOrEqual(
				21_000,
			);
			expect(Date.parse(rotated.qrExpiresAt ?? "")).toBeLessThan(
				Date.parse(ready.qrExpiresAt ?? ""),
			);

			harness.events.emit("creds.update", verifiedQrUpdate());
			harness.events.emit("connection.update", { isNewLogin: true, qr: undefined });
			expect(harness.socketConfigurations[0]?.auth.creds.registered).toBe(false);
			expect(runtime.pairingStatus()).toEqual({ status: "starting", registered: true });
			await expect(runtime.startQrPairing()).rejects.toThrow("physical_account_already_registered");
			await expect(runtime.cancelPairing()).rejects.toThrow("registered_session_requires_logout");

			harness.events.emit("connection.update", {
				connection: "close",
				lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
			});
			expect(runtime.health()).toMatchObject({ status: "disconnected", registered: true });
			await runtime.retryPairing();
			expect(harness.socketConfigurations).toHaveLength(2);
			harness.events.emit("connection.update", { connection: "open" });
			expect(runtime.pairingStatus()).toEqual({ status: "connected", registered: true });
			await runtime.stop();

			const reopenedHarness = createHarness({ registered: false });
			reopenedRuntime = new BaileysSocketRuntime(config, {
				socketFactory: reopenedHarness.dependencies.socketFactory,
			});
			await reopenedRuntime.start();
			expect(reopenedHarness.socketConfigurations).toHaveLength(1);
			const restoredCreds = reopenedHarness.socketConfigurations[0]?.auth.creds;
			expect(restoredCreds?.registered).toBe(false);
			expect(restoredCreds?.me).toEqual({
				id: "15550001111:1@s.whatsapp.net",
				name: "Test account",
				lid: "15550001111@lid",
			});
			expect(reopenedRuntime.health()).toMatchObject({ status: "connecting", registered: true });
			reopenedHarness.events.emit("connection.update", { connection: "open" });
			expect(reopenedRuntime.health()).toMatchObject({ status: "connected", registered: true });
			await expect(reopenedRuntime.cancelPairing()).rejects.toThrow(
				"registered_session_requires_logout",
			);
			expect(await reopenedRuntime.logoutPairing()).toEqual({
				status: "stopped",
				registered: false,
			});
			expect(reopenedHarness.logoutCalls).toBe(1);
		} finally {
			await reopenedRuntime?.stop();
			await runtime.stop();
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("retains quarantined rc14 auth across process restart until explicit recovery", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-runtime-logout-"));
		const config = { ...sidecarConfig(), sessionDir };
		const firstHarness = createHarness({ registered: false });
		const first = new BaileysSocketRuntime(config, {
			socketFactory: firstHarness.dependencies.socketFactory,
		});
		let second: BaileysSocketRuntime | undefined;
		try {
			await first.startQrPairing();
			firstHarness.events.emit("creds.update", verifiedQrUpdate());
			firstHarness.events.emit("connection.update", { connection: "open" });
			firstHarness.events.emit("connection.update", {
				connection: "close",
				lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
			});
			expect(first.health()).toMatchObject({
				status: "disconnected",
				registered: true,
				lastDisconnectReason: "remote_logged_out",
			});
			await first.stop();

			const secondHarness = createHarness({ registered: false });
			second = new BaileysSocketRuntime(config, {
				socketFactory: secondHarness.dependencies.socketFactory,
			});
			await second.start();
			expect(secondHarness.socketConfigurations).toHaveLength(0);
			expect(second.health()).toMatchObject({
				status: "disconnected",
				registered: true,
				lastDisconnectReason: "remote_logged_out",
			});
			expect(await second.recoverPairing()).toEqual({
				status: "stopped",
				registered: false,
			});
		} finally {
			await second?.stop();
			await first.stop();
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("supports the pinned rc14 pairing-code method without retaining phone input", async () => {
		const harness = createHarness({ registered: false });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);

		const pairing = await runtime.requestPairingCode("15551234567");

		expect(pairing).toEqual({
			status: "pairing_code",
			registered: false,
			method: "code",
			code: "12345678",
		});
		expect(harness.pairingCodePhones).toEqual(["15551234567"]);
		await expect(runtime.startQrPairing()).rejects.toThrow("pairing_method_already_selected");
		expect(harness.socketConfigurations).toHaveLength(1);
		await runtime.cancelPairing();
		expect(harness.physicalAuthResets).toBe(1);
		expect(runtime.pairingStatus()).toEqual({ status: "stopped", registered: false });
		await runtime.stop();
	});

	it("keeps unregistered QR transport transitions in the pairing lifecycle", async () => {
		const harness = createHarness({ registered: false });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);

		await runtime.startQrPairing();
		harness.events.emit("connection.update", { connection: "open" });
		expect(runtime.pairingStatus()).toEqual({
			status: "starting",
			registered: false,
			method: "qr",
		});

		harness.events.emit("connection.update", { qr: "sensitive-qr-value" });
		harness.events.emit("connection.update", {
			connection: "close",
			lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
		});
		expect(runtime.pairingStatus()).toMatchObject({
			status: "starting",
			registered: false,
			method: "qr",
		});

		await runtime.cancelPairing();
		await runtime.stop();
	});

	it("confirms physical logout before clearing registered auth", async () => {
		const harness = createHarness();
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });

		const loggedOut = await runtime.logoutPairing();

		expect(harness.logoutCalls).toBe(1);
		expect(harness.physicalAuthResets).toBe(1);
		expect(loggedOut).toEqual({ status: "stopped", registered: false });
		await runtime.stop();
	});

	it("serializes concurrent QR starts onto one physical socket", async () => {
		const harness = createHarness({ registered: false });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);

		await Promise.all([runtime.startQrPairing(), runtime.startQrPairing()]);

		expect(harness.socketConfigurations).toHaveLength(1);
		await runtime.cancelPairing();
		await runtime.stop();
	});

	it("keeps and retries the same socket when pairing cancellation is not confirmed", async () => {
		const harness = createHarness({ registered: false, cancelFailures: 1 });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.startQrPairing();

		await expect(runtime.cancelPairing()).rejects.toThrow("injected cancel failure");
		expect(runtime.health()).toMatchObject({ status: "disconnected", registered: false });
		expect(harness.socketConfigurations).toHaveLength(1);
		expect(harness.physicalAuthResets).toBe(0);

		const canceled = await runtime.cancelPairing();
		expect(harness.socketConfigurations).toHaveLength(1);
		expect(harness.physicalAuthResets).toBe(1);
		expect(canceled).toEqual({ status: "stopped", registered: false });
		await runtime.stop();
	});

	it("keeps and retries the same socket when logout is not confirmed", async () => {
		const harness = createHarness({ logoutFailures: 1 });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });

		await expect(runtime.logoutPairing()).rejects.toThrow("injected logout failure");
		expect(runtime.health()).toMatchObject({ status: "connected", registered: true });
		expect(harness.socketConfigurations).toHaveLength(1);

		const loggedOut = await runtime.logoutPairing();
		expect(harness.logoutCalls).toBe(2);
		expect(harness.socketConfigurations).toHaveLength(1);
		expect(loggedOut).toEqual({ status: "stopped", registered: false });
		await runtime.stop();
	});

	it("cancels the scheduled reconnect before a manual registered-session retry", async () => {
		const harness = createHarness();
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", {
			connection: "close",
			lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
		});

		await runtime.retryPairing();
		harness.events.emit("connection.update", { connection: "open" });
		await new Promise((resolve) => setTimeout(resolve, 3_100));

		expect(harness.socketConfigurations).toHaveLength(2);
		expect(runtime.health()).toMatchObject({ status: "connected", registered: true });
		await runtime.stop();
	});

	it("quarantines unexpected provider logout until explicit recovery", async () => {
		const harness = createHarness();
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });

		harness.events.emit("connection.update", {
			connection: "close",
			lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
		});

		expect(harness.physicalAuthResets).toBe(0);
		expect(runtime.health()).toMatchObject({
			status: "disconnected",
			registered: true,
			lastDisconnectReason: "remote_logged_out",
		});
		await expect(runtime.retryPairing()).rejects.toThrow("physical_auth_recovery_required");
		expect(harness.physicalAuthResets).toBe(0);

		const recovered = await runtime.recoverPairing();
		expect(harness.physicalAuthResets).toBe(1);
		expect(recovered).toEqual({ status: "stopped", registered: false });
		await runtime.stop();
	});

	it("rejects recovery unless a retained remote logout requires it", async () => {
		const harness = createHarness();
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });

		await expect(runtime.recoverPairing()).rejects.toThrow("physical_auth_recovery_not_required");
		expect(harness.physicalAuthResets).toBe(0);
		await runtime.stop();
	});

	it("passes the exact audited Web version to makeWASocket without dynamic discovery", async () => {
		const harness = createHarness();
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);

		await runtime.start();

		expect(harness.socketConfigurations).toHaveLength(1);
		expect(harness.socketConfigurations[0]?.version).toEqual([2, 3000, 1_043_857_760]);
		const runtimeSource = readFileSync(new URL("runtime.ts", import.meta.url), "utf8");
		expect(runtimeSource).not.toContain("fetchLatestBaileysVersion");
		expect(runtimeSource).not.toContain("useMultiFileAuthState");
		await runtime.stop();
	});

	it("persists creds.update and fail-stops the socket on auth persistence failure", async () => {
		const harness = createHarness({ failCredsWrite: true });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });
		expect(runtime.health().connected).toBe(true);

		harness.events.emit("creds.update", { registered: true });

		expect(harness.credsUpdates).toEqual([{ registered: true }]);
		expect(harness.endedErrors).toHaveLength(1);
		expect(runtime.health()).toMatchObject({
			status: "disconnected",
			connected: false,
			lastDisconnectReason: "auth_state_persistence_failed",
		});
		await runtime.stop();
	});

	it("persists an inbound batch synchronously before the event handler returns", async () => {
		const order: string[] = [];
		const harness = createHarness({
			onAppendProviderEvents: () => order.push("persisted"),
		});
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();

		harness.events.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: {
						id: "provider-message-1",
						remoteJid: "15550001111@s.whatsapp.net",
						fromMe: false,
					},
					pushName: "Provider sender",
					messageTimestamp: 123,
					message: { conversation: "hello" },
				},
			],
		});
		order.push("handler-returned");

		expect(order).toEqual(["persisted", "handler-returned"]);
		expect(harness.providerEventBatches).toHaveLength(1);
		expect(harness.providerEventBatches[0]?.[0]).toMatchObject({
			eventType: "messages.upsert",
			messageId: "provider-message-1",
			remoteJid: "15550001111@s.whatsapp.net",
			fromMe: false,
			pushName: "Provider sender",
			messageTimestamp: 123,
		});
		expect(
			proto.Message.decode(
				Buffer.from(harness.providerEventBatches[0]?.[0]?.messageProtoBase64 ?? "", "base64"),
			).conversation,
		).toBe("hello");
		await runtime.stop();
	});

	it("fail-stops instead of dropping an inbound event when spool persistence fails", async () => {
		const harness = createHarness({ failInboxWrite: true });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });

		harness.events.emit("messages.upsert", {
			type: "notify",
			messages: [
				{
					key: {
						id: "provider-message-1",
						remoteJid: "15550001111@s.whatsapp.net",
						fromMe: false,
					},
					message: { conversation: "must-not-drop" },
				},
			],
		});

		expect(harness.endedErrors).toHaveLength(1);
		expect(runtime.health()).toMatchObject({
			status: "disconnected",
			connected: false,
			lastDisconnectReason: "provider_inbox_persistence_failed",
		});
		await runtime.stop();
	});

	it("fail-stops the real SQLite-backed runtime when inbox capacity is exhausted", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-runtime-capacity-"));
		const harness = createHarness();
		const config = {
			...sidecarConfig(),
			sessionDir,
			providerInbox: { maxEvents: 1, maxBytes: 32 },
		};
		const runtime = new BaileysSocketRuntime(config, {
			socketFactory: harness.dependencies.socketFactory,
		});
		try {
			await runtime.startQrPairing();
			harness.events.emit("connection.update", { connection: "open" });

			harness.events.emit("messages.upsert", {
				type: "notify",
				messages: [
					{
						key: {
							id: "provider-message-over-capacity",
							remoteJid: "15550001111@s.whatsapp.net",
							fromMe: false,
						},
						message: { conversation: "must-fail-stop" },
					},
				],
			});

			expect(harness.endedErrors).toHaveLength(1);
			expect(runtime.health()).toMatchObject({
				status: "disconnected",
				connected: false,
				lastDisconnectReason: "provider_inbox_persistence_failed",
			});
		} finally {
			await runtime.stop();
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("durably stores exact retry proto before calling the physical relay", async () => {
		const order: string[] = [];
		const harness = createHarness({
			onStoreRetryMessage: () => order.push("retry-stored"),
			onRelayMessage: () => order.push("relayed"),
		});
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });
		const encoded = proto.Message.encode({ conversation: "outbound" }).finish();

		await runtime.relayMessage({
			jid: "15550002222@s.whatsapp.net",
			messageId: "outbound-1",
			messageProto: encoded,
			additionalAttributes: { addressing_mode: "lid" },
			additionalNodes: [{ tag: "meta", attrs: { polltype: "creation" } }],
		});

		expect(order).toEqual(["retry-stored", "relayed"]);
		expect(harness.relayRequests).toEqual([
			{
				jid: "15550002222@s.whatsapp.net",
				messageId: "outbound-1",
				additionalNodes: [{ tag: "meta", attrs: { polltype: "creation" } }],
			},
		]);
		expect(harness.retryMessages).toEqual([
			{
				remoteJid: "15550002222@s.whatsapp.net",
				messageId: "outbound-1",
				message: Buffer.from(encoded),
			},
		]);
		await runtime.stop();
	});

	it("fail-stops on retry persistence failure and never calls the physical relay", async () => {
		const harness = createHarness({ failRetryWrite: true });
		const runtime = new BaileysSocketRuntime(sidecarConfig(), harness.dependencies);
		await runtime.start();
		harness.events.emit("connection.update", { connection: "open" });
		const encoded = proto.Message.encode({ conversation: "outbound" }).finish();

		await expect(
			runtime.relayMessage({
				jid: "15550002222@s.whatsapp.net",
				messageId: "outbound-1",
				messageProto: encoded,
				additionalAttributes: {},
				additionalNodes: [],
			}),
		).rejects.toThrow("injected retry write failure");
		expect(harness.relayRequests).toEqual([]);
		expect(harness.endedErrors).toHaveLength(1);
		expect(runtime.health().lastDisconnectReason).toBe("provider_retry_state_persistence_failed");
		await runtime.stop();
	});
});

type HarnessOptions = {
	registered?: boolean;
	user?: AuthenticationCreds["me"];
	failCredsWrite?: boolean;
	failInboxWrite?: boolean;
	failRetryWrite?: boolean;
	cancelFailures?: number;
	logoutFailures?: number;
	onAppendProviderEvents?: () => void;
	onStoreRetryMessage?: () => void;
	onRelayMessage?: () => void;
};

function createHarness(options: HarnessOptions = {}) {
	const events = new EventEmitter();
	const credsUpdates: Array<Record<string, unknown>> = [];
	const providerEventBatches: ProviderMessageEventInput[][] = [];
	const retryMessages: Array<{ remoteJid: string; messageId: string; message: Buffer }> = [];
	const relayRequests: Array<{
		jid: string;
		messageId?: string;
		additionalNodes?: readonly BinaryNode[];
	}> = [];
	const endedErrors: Error[] = [];
	const pairingCodePhones: string[] = [];
	const socketConfigurations: Array<Parameters<ProviderSocketFactory>[0]> = [];
	let logoutCalls = 0;
	let cancelFailuresRemaining = options.cancelFailures ?? 0;
	let logoutFailuresRemaining = options.logoutFailures ?? 0;
	let physicalAuthResets = 0;
	let physicalAuthQuarantineReason: string | undefined;
	let stateClosed = false;
	const creds = initAuthCreds();
	creds.registered = options.registered ?? true;
	if (creds.registered) {
		creds.me = options.user ?? { id: "15550001111:1@s.whatsapp.net", name: "Test account" };
	}
	const providerState = {
		state: {
			creds,
			keys: {
				async get() {
					return {};
				},
				async set() {},
				async clear() {},
			},
		},
		retryCounterCache: {
			get<T>(): T | undefined {
				return undefined;
			},
			set() {},
			del() {},
			flushAll() {},
		},
		saveCreds(update = {}) {
			credsUpdates.push(update);
			if (options.failCredsWrite) throw new Error("injected creds write failure");
			Object.assign(creds, update);
		},
		physicalAuthQuarantineReason() {
			return physicalAuthQuarantineReason;
		},
		quarantinePhysicalAuth(reason: string) {
			physicalAuthQuarantineReason = reason;
		},
		storeRetryMessage(remoteJid: string, messageId: string, message: Uint8Array) {
			retryMessages.push({ remoteJid, messageId, message: Buffer.from(message) });
			options.onStoreRetryMessage?.();
			if (options.failRetryWrite) throw new Error("injected retry write failure");
		},
		getRetryMessage() {
			return undefined;
		},
		appendProviderEvents(batch: readonly ProviderMessageEventInput[]) {
			providerEventBatches.push([...batch]);
			options.onAppendProviderEvents?.();
			if (options.failInboxWrite) throw new Error("injected inbox write failure");
		},
		providerEvents() {
			return [];
		},
		acknowledgeProviderEvents() {},
		resetPhysicalAuth() {
			physicalAuthResets += 1;
			physicalAuthQuarantineReason = undefined;
			for (const key of Object.keys(creds)) Reflect.deleteProperty(creds, key);
			Object.assign(creds, initAuthCreds());
		},
		close() {
			stateClosed = true;
		},
	};
	const socketFactory: ProviderSocketFactory = (configuration) => {
		socketConfigurations.push(configuration);
		return {
			user: undefined,
			ev: events,
			async end(error) {
				endedErrors.push(error ?? new Error("socket ended"));
				if (cancelFailuresRemaining > 0) {
					cancelFailuresRemaining -= 1;
					throw new Error("injected cancel failure");
				}
			},
			async logout() {
				logoutCalls += 1;
				if (logoutFailuresRemaining > 0) {
					logoutFailuresRemaining -= 1;
					throw new Error("injected logout failure");
				}
				creds.registered = false;
			},
			async requestPairingCode(phoneNumber) {
				pairingCodePhones.push(phoneNumber);
				creds.me = { id: `${phoneNumber}@s.whatsapp.net`, name: "~" };
				creds.pairingCode = "12345678";
				events.emit("creds.update", creds);
				return "12345678";
			},
			async relayMessage(jid, _message, relayOptions) {
				relayRequests.push({
					jid,
					...(relayOptions.messageId ? { messageId: relayOptions.messageId } : {}),
					...(relayOptions.additionalNodes
						? { additionalNodes: relayOptions.additionalNodes }
						: {}),
				});
				options.onRelayMessage?.();
				return relayOptions.messageId ?? "generated-message-id";
			},
			async sendNode() {},
			async query() {
				return { tag: "iq", attrs: { type: "result" } };
			},
		};
	};
	return {
		dependencies: { socketFactory, providerState },
		events,
		credsUpdates,
		providerEventBatches,
		retryMessages,
		relayRequests,
		endedErrors,
		pairingCodePhones,
		socketConfigurations,
		get logoutCalls() {
			return logoutCalls;
		},
		get physicalAuthResets() {
			return physicalAuthResets;
		},
		get stateClosed() {
			return stateClosed;
		},
	};
}

function sidecarConfig(): SidecarSessionConfig {
	return {
		sessionId: ACCOUNT_ID,
		host: "127.0.0.1",
		port: 8787,
		apiToken: "test-token",
		sessionDir: "/unused/in-memory-test-state",
		logLevel: "silent",
		webVersion: parseAuditedWhatsAppWebVersion("2.3000.1043857760"),
		providerInbox: { maxEvents: 100, maxBytes: 1024 * 1024 },
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
		me: {
			id: "15550001111:1@s.whatsapp.net",
			name: "Test account",
			lid: "15550001111@lid",
		},
		signalIdentities: [
			{
				identifier: { name: "15550001111@lid", deviceId: 0 },
				identifierKey: Buffer.from([5]),
			},
		],
	};
}
