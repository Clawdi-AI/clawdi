import {
	type AuthenticationCreds,
	type BaileysEventMap,
	type BinaryNode,
	type CacheStore,
	type ConnectionState,
	DisconnectReason,
	makeWASocket,
	proto,
	type SignalKeyStore,
	type WASocket,
} from "baileys";
import pino, { type Logger } from "pino";

import { AUDITED_PROVIDER_RELEASE } from "./audited-version.js";
import type { SidecarSessionConfig } from "./config.js";
import {
	isLinkedAuthenticationCreds,
	type ProviderMessageEvent,
	type ProviderMessageEventInput,
	type ProviderStateFailureOperation,
	SQLiteProviderState,
} from "./sqlite-state.js";
import {
	type BaileysRuntime,
	PairingLifecycleError,
	type PairingStatus,
	type RelayMessageRequest,
	type RuntimeHealth,
	RuntimeNotConnectedError,
	type RuntimeStatus,
	SIDECAR_CAPABILITIES,
} from "./types.js";

const RECONNECT_DELAY_MS = 3_000;
const FIRST_QR_TTL_MS = 60_000;
const ROTATED_QR_TTL_MS = 20_000;
const REMOTE_LOGOUT_REASON = "remote_logged_out";
const E164_DIGITS = /^[1-9][0-9]{6,14}$/;
const TRANSIENT_DISCONNECT_REASONS = new Set<number>([
	DisconnectReason.connectionClosed,
	DisconnectReason.connectionLost,
	DisconnectReason.restartRequired,
	DisconnectReason.unavailableService,
]);

type SocketConfiguration = Parameters<typeof makeWASocket>[0];

type ProviderSocketEvents = {
	on(event: "creds.update", listener: (update: Partial<AuthenticationCreds>) => void): void;
	on(
		event: "messages.upsert",
		listener: (update: BaileysEventMap["messages.upsert"]) => void,
	): void;
	on(event: "connection.update", listener: (update: Partial<ConnectionState>) => void): void;
};

type ProviderSocket = Pick<
	WASocket,
	"user" | "end" | "logout" | "relayMessage" | "requestPairingCode" | "sendNode" | "query"
> & {
	ev: ProviderSocketEvents;
};

export type ProviderSocketFactory = (config: SocketConfiguration) => ProviderSocket;

type ProviderState = {
	state: {
		creds: AuthenticationCreds;
		keys: SignalKeyStore;
	};
	retryCounterCache: CacheStore;
	saveCreds(update?: Partial<AuthenticationCreds>): void;
	physicalAuthQuarantineReason(): string | undefined;
	quarantinePhysicalAuth(reason: string): void;
	storeRetryMessage(remoteJid: string, messageId: string, message: Uint8Array): void;
	getRetryMessage(
		remoteJid: string | null | undefined,
		messageId: string | null | undefined,
	): proto.IMessage | undefined;
	appendProviderEvents(events: readonly ProviderMessageEventInput[]): void;
	providerEvents(limit: number): ProviderMessageEvent[];
	acknowledgeProviderEvents(throughSequence: number): void;
	resetPhysicalAuth(): void;
	close(): void;
};

export type BaileysRuntimeDependencies = {
	socketFactory?: ProviderSocketFactory;
	providerState?: ProviderState;
};

const defaultProviderSocketFactory: ProviderSocketFactory = (config) => makeWASocket(config);

export class BaileysSocketRuntime implements BaileysRuntime {
	private socket: ProviderSocket | null = null;
	private status: RuntimeStatus = "stopped";
	private lastDisconnectReason: string | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private fatalReason: string | undefined;
	private readonly startedAt = Date.now();
	private readonly logger: Logger;
	private readonly baileysLogger: Logger;
	private readonly providerState: ProviderState;
	private readonly socketFactory: ProviderSocketFactory;
	private stateClosed = false;
	private pairingMethod: "qr" | "code" | undefined;
	private pairingQr: string | undefined;
	private pairingQrExpiresAt: number | undefined;
	private pairingCode: string | undefined;
	private qrGeneration = 0;
	private physicalAuthResetGeneration = 0;
	private lifecycleTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly config: SidecarSessionConfig,
		dependencies: BaileysRuntimeDependencies = {},
	) {
		this.logger = pino({ level: config.logLevel }).child({ sessionId: config.sessionId });
		// Upstream Baileys logs can contain JIDs/device metadata. The sidecar
		// emits only its own generic lifecycle logs at the configured level.
		this.baileysLogger = pino({ level: "silent" });
		this.socketFactory = dependencies.socketFactory ?? defaultProviderSocketFactory;
		this.providerState =
			dependencies.providerState ??
			new SQLiteProviderState(
				config.sessionDir,
				config.sessionId,
				config.webVersion,
				config.providerInbox,
				(operation, error) => this.markStateFatal(operation, error),
			);
		const quarantineReason = this.providerState.physicalAuthQuarantineReason();
		if (quarantineReason) {
			this.fatalReason = quarantineReason;
			this.lastDisconnectReason = quarantineReason;
			this.status = "disconnected";
			this.logger.warn(
				{ reason: quarantineReason },
				"WhatsApp linked-device auth quarantine restored from durable state",
			);
		}
	}

	async start(): Promise<void> {
		if (this.stateClosed) throw new Error("WhatsApp provider state is closed");
		// Keep health and explicit recovery routes reachable while quarantined.
		// Data-plane methods still fail closed through requireSocket(), and retry
		// applies the reason-specific recovery policy below.
		if (this.fatalReason) return;
		// Session-scoped status and health requests call start() before dispatch.
		// An unregistered socket may already be generating or displaying a QR;
		// preserve that sole physical owner instead of resetting its lifecycle.
		if (this.socket) return;
		if (!isLinkedAuthenticationCreds(this.providerState.state.creds)) {
			this.status = "stopped";
			return;
		}
		this.status = "starting";
		try {
			await this.openSocket();
		} catch (error: unknown) {
			this.status = "disconnected";
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		const socket = this.socket;
		this.socket = null;
		this.status = "stopped";
		try {
			if (socket) {
				await socket.end(new Error("Clawdi WhatsApp provider transport stopped"));
			}
		} finally {
			this.closeState();
		}
	}

	health(): RuntimeHealth {
		// rc14 chooses login vs registration from durable creds.me. Report that
		// same persisted identity even while the transport is reconnecting or
		// quarantined; socket liveness must not erase account identity.
		const durableUser = this.providerState.state.creds.me;
		const user = durableUser
			? {
					id: durableUser.id,
					name: durableUser.name,
				}
			: undefined;
		return {
			status: this.status,
			connected: this.status === "connected",
			registered: isLinkedAuthenticationCreds(this.providerState.state.creds),
			sessionId: this.config.sessionId,
			advertisedRelease: AUDITED_PROVIDER_RELEASE,
			uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
			...(user ? { user } : {}),
			...(this.lastDisconnectReason ? { lastDisconnectReason: this.lastDisconnectReason } : {}),
		};
	}

	capabilities() {
		return SIDECAR_CAPABILITIES;
	}

	pairingStatus(): PairingStatus {
		const registered = isLinkedAuthenticationCreds(this.providerState.state.creds);
		if (registered) this.clearPairingSecrets();
		const qrIsCurrent =
			this.pairingQr !== undefined &&
			this.pairingQrExpiresAt !== undefined &&
			Date.now() < this.pairingQrExpiresAt;
		const status =
			this.status === "connecting" || this.status === "starting"
				? "starting"
				: this.status === "pairing_qr" && !qrIsCurrent
					? "starting"
					: this.status;
		return {
			status,
			registered,
			...(this.pairingMethod ? { method: this.pairingMethod } : {}),
			...(qrIsCurrent && this.pairingQr && this.pairingQrExpiresAt
				? {
						qr: this.pairingQr,
						qrExpiresAt: new Date(this.pairingQrExpiresAt).toISOString(),
					}
				: {}),
			...(this.pairingCode ? { code: this.pairingCode } : {}),
		};
	}

	async startQrPairing(): Promise<PairingStatus> {
		return await this.runLifecycle(async () => {
			this.requirePairable();
			if (this.socket && this.pairingMethod === "qr") return this.pairingStatus();
			if (this.socket && this.pairingMethod === "code") {
				throw new PairingLifecycleError("pairing_method_already_selected");
			}
			this.pairingMethod = "qr";
			this.pairingCode = undefined;
			this.pairingQr = undefined;
			this.pairingQrExpiresAt = undefined;
			this.qrGeneration = 0;
			if (!this.socket) await this.openSocket();
			return this.pairingStatus();
		});
	}

	async requestPairingCode(phoneNumber: string): Promise<PairingStatus> {
		return await this.runLifecycle(async () => {
			this.requirePairable();
			if (!E164_DIGITS.test(phoneNumber)) {
				throw new PairingLifecycleError("invalid_phone_number");
			}
			if (!this.socket) await this.openSocket();
			const socket = this.socket;
			if (!socket) throw new PairingLifecycleError("pairing_socket_unavailable");
			const code = await socket.requestPairingCode(phoneNumber);
			if (!code || code.length > 200) throw new PairingLifecycleError("invalid_pairing_code");
			this.pairingMethod = "code";
			this.pairingQr = undefined;
			this.pairingQrExpiresAt = undefined;
			this.pairingCode = code;
			this.status = "pairing_code";
			return this.pairingStatus();
		});
	}

	async cancelPairing(): Promise<PairingStatus> {
		return await this.runLifecycle(async () => {
			if (isLinkedAuthenticationCreds(this.providerState.state.creds)) {
				throw new PairingLifecycleError("registered_session_requires_logout");
			}
			return await this.cancelPairingUnsafe();
		});
	}

	async logoutPairing(): Promise<PairingStatus> {
		return await this.runLifecycle(async () => {
			if (!isLinkedAuthenticationCreds(this.providerState.state.creds)) {
				return await this.cancelPairingUnsafe();
			}
			const socket = this.socket;
			if (!socket || this.status !== "connected") {
				throw new PairingLifecycleError("registered_session_not_connected");
			}
			const resetGeneration = this.physicalAuthResetGeneration;
			try {
				await socket.logout("Clawdi user requested linked-device logout");
			} catch (error: unknown) {
				// A failed request does not confirm companion-device removal. Keep
				// this socket so a retry cannot create a second physical owner.
				if (!isLinkedAuthenticationCreds(this.providerState.state.creds)) {
					if (this.physicalAuthResetGeneration === resetGeneration) this.resetPhysicalAuth();
					if (this.socket === socket) this.socket = null;
					this.clearPairingSecrets();
					this.status = "stopped";
					return this.pairingStatus();
				}
				throw error;
			}
			if (this.socket === socket) this.socket = null;
			if (this.physicalAuthResetGeneration === resetGeneration) this.resetPhysicalAuth();
			this.clearPairingSecrets();
			this.status = "stopped";
			this.lastDisconnectReason = undefined;
			this.fatalReason = undefined;
			return this.pairingStatus();
		});
	}

	async retryPairing(): Promise<PairingStatus> {
		return await this.runLifecycle(async () => {
			if (!isLinkedAuthenticationCreds(this.providerState.state.creds)) {
				throw new PairingLifecycleError("unregistered_session_requires_pairing");
			}
			if (this.fatalReason === REMOTE_LOGOUT_REASON) {
				throw new PairingLifecycleError("physical_auth_recovery_required");
			}
			if (!this.socket) {
				this.fatalReason = undefined;
				await this.openSocket();
			}
			return this.pairingStatus();
		});
	}

	async recoverPairing(): Promise<PairingStatus> {
		return await this.runLifecycle(async () => {
			if (
				this.fatalReason !== REMOTE_LOGOUT_REASON ||
				!isLinkedAuthenticationCreds(this.providerState.state.creds)
			) {
				throw new PairingLifecycleError("physical_auth_recovery_not_required");
			}
			this.clearReconnectTimer();
			this.resetPhysicalAuth();
			this.clearPairingSecrets();
			this.status = "stopped";
			this.lastDisconnectReason = undefined;
			this.fatalReason = undefined;
			return this.pairingStatus();
		});
	}

	async relayMessage(request: RelayMessageRequest): Promise<string | undefined> {
		const socket = this.requireSocket();
		const message = proto.Message.decode(request.messageProto);
		try {
			this.providerState.storeRetryMessage(request.jid, request.messageId, request.messageProto);
		} catch (error: unknown) {
			this.markFatal("provider_retry_state_persistence_failed", asError(error));
			throw error;
		}
		return await socket.relayMessage(request.jid, message, {
			messageId: request.messageId,
			additionalAttributes: request.additionalAttributes,
			additionalNodes: request.additionalNodes,
		});
	}

	async sendNode(node: BinaryNode): Promise<void> {
		await this.requireSocket().sendNode(node);
	}

	async query(node: BinaryNode, timeoutMs: number): Promise<BinaryNode | null> {
		const response = await this.requireSocket().query(node, timeoutMs);
		if (!isBinaryNode(response)) return null;
		return response;
	}

	providerEvents(limit: number): ProviderMessageEvent[] {
		try {
			return this.providerState.providerEvents(limit);
		} catch (error: unknown) {
			this.markFatal("provider_inbox_persistence_failed", asError(error));
			throw error;
		}
	}

	acknowledgeProviderEvents(throughSequence: number): void {
		try {
			this.providerState.acknowledgeProviderEvents(throughSequence);
		} catch (error: unknown) {
			this.markFatal("provider_inbox_persistence_failed", asError(error));
			throw error;
		}
	}

	private async openSocket(): Promise<void> {
		// A manual lifecycle retry supersedes any scheduled reconnect. This
		// keeps one runtime from opening a second socket when the old timer fires.
		this.clearReconnectTimer();
		if (this.socket) return;
		this.status = "connecting";
		const socket = this.socketFactory({
			version: this.config.webVersion,
			auth: this.providerState.state,
			logger: this.baileysLogger,
			printQRInTerminal: false,
			syncFullHistory: false,
			markOnlineOnConnect: false,
			msgRetryCounterCache: this.providerState.retryCounterCache,
			getMessage: async (key) =>
				this.providerState.getRetryMessage(key.remoteJid, key.id) ?? { conversation: "" },
		});
		this.socket = socket;
		socket.ev.on("creds.update", (update) => {
			try {
				this.providerState.saveCreds(update);
				if (isLinkedAuthenticationCreds(this.providerState.state.creds)) {
					this.clearPairingSecrets();
				}
			} catch (error: unknown) {
				this.markFatal("auth_state_persistence_failed", asError(error));
			}
		});
		socket.ev.on("messages.upsert", ({ messages, type }) => {
			if (this.socket !== socket || type !== "notify") return;
			try {
				const events: ProviderMessageEventInput[] = [];
				for (const message of messages) {
					const remoteJid = message.key.remoteJid;
					const messageId = message.key.id;
					if (!remoteJid || !messageId || !message.message || message.key.fromMe === true) continue;
					events.push({
						eventType: "messages.upsert",
						messageId,
						remoteJid,
						...optionalEventString(message.key, "remoteJidAlt"),
						...optionalEventString(message.key, "participant"),
						...optionalEventString(message.key, "participantAlt"),
						fromMe: false,
						...(message.pushName ? { pushName: message.pushName } : {}),
						...messageTimestampField(message.messageTimestamp),
						messageProtoBase64: Buffer.from(
							proto.Message.encode(message.message).finish(),
						).toString("base64"),
					});
				}
				this.providerState.appendProviderEvents(events);
			} catch (error: unknown) {
				this.markFatal("provider_inbox_persistence_failed", asError(error));
			}
		});
		socket.ev.on("connection.update", (update) => {
			if (this.socket !== socket) return;
			const { connection, lastDisconnect, qr } = update;
			if (qr && this.pairingMethod !== "code") {
				this.pairingMethod = "qr";
				this.pairingQr = qr;
				this.qrGeneration += 1;
				this.pairingQrExpiresAt =
					Date.now() + (this.qrGeneration === 1 ? FIRST_QR_TTL_MS : ROTATED_QR_TTL_MS);
				this.status = "pairing_qr";
			}
			if (connection === "open") {
				if (this.fatalReason) return;
				this.status = "connected";
				this.lastDisconnectReason = undefined;
				this.logger.info("WhatsApp connected");
				return;
			}
			if (connection !== "close") return;
			this.socket = null;
			if (this.status === "stopped") return;
			this.status = "disconnected";
			const reason = disconnectReason(lastDisconnect?.error);
			if (this.fatalReason) {
				this.lastDisconnectReason = this.fatalReason;
				return;
			}
			this.lastDisconnectReason = reason === undefined ? "unknown_disconnect" : String(reason);
			this.logger.warn({ reason }, "WhatsApp connection closed");
			if (reason === DisconnectReason.loggedOut) {
				// A provider-side loggedOut signal is not proof that the user asked
				// Clawdi to destroy its durable auth state. Quarantine the session so
				// ordinary retries and process restarts cannot turn a transport event
				// into irreversible credential loss. The authenticated recovery route
				// is the only path that may clear this retained state for re-pairing.
				try {
					this.providerState.quarantinePhysicalAuth(REMOTE_LOGOUT_REASON);
					this.clearReconnectTimer();
					this.clearPairingSecrets();
					this.fatalReason = REMOTE_LOGOUT_REASON;
					this.lastDisconnectReason = REMOTE_LOGOUT_REASON;
					this.logger.error(
						{ reason: REMOTE_LOGOUT_REASON },
						"WhatsApp linked-device auth quarantined; explicit repair required",
					);
				} catch (error: unknown) {
					this.markStateFatal("physical_auth_quarantine", asError(error));
				}
				return;
			}
			if (reason !== undefined && TRANSIENT_DISCONNECT_REASONS.has(reason)) {
				this.scheduleReconnect();
				return;
			}
			this.fatalReason = "non_transient_disconnect";
			this.lastDisconnectReason = this.fatalReason;
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.fatalReason || this.status === "stopped") return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (this.fatalReason || this.status === "stopped") return;
			this.openSocket().catch((error: unknown) => {
				this.status = "disconnected";
				this.lastDisconnectReason = error instanceof Error ? error.message : String(error);
				this.logger.error({ error }, "WhatsApp reconnect failed");
				this.scheduleReconnect();
			});
		}, RECONNECT_DELAY_MS);
	}

	private requireSocket(): ProviderSocket {
		if (!this.socket || this.status !== "connected" || this.fatalReason) {
			throw new RuntimeNotConnectedError();
		}
		return this.socket;
	}

	private requirePairable(): void {
		if (this.stateClosed || this.fatalReason) {
			throw new PairingLifecycleError("provider_state_unavailable");
		}
		if (isLinkedAuthenticationCreds(this.providerState.state.creds)) {
			throw new PairingLifecycleError("physical_account_already_registered");
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private async cancelPairingUnsafe(): Promise<PairingStatus> {
		this.clearReconnectTimer();
		const socket = this.socket;
		if (socket) {
			try {
				await socket.end(new Error("WhatsApp linked-device session stopped"));
			} catch (error: unknown) {
				// Do not detach an unconfirmed physical owner. A later cancel can
				// retry this same socket, but pairing cannot open a second one.
				this.fatalReason = "pairing_socket_stop_unconfirmed";
				this.status = "disconnected";
				throw error;
			}
			if (this.socket === socket) this.socket = null;
		}
		this.clearReconnectTimer();
		this.resetPhysicalAuth();
		this.clearPairingSecrets();
		this.status = "stopped";
		this.lastDisconnectReason = undefined;
		this.fatalReason = undefined;
		return this.pairingStatus();
	}

	private clearPairingSecrets(): void {
		this.pairingMethod = undefined;
		this.pairingQr = undefined;
		this.pairingQrExpiresAt = undefined;
		this.pairingCode = undefined;
		this.qrGeneration = 0;
	}

	private resetPhysicalAuth(): void {
		this.providerState.resetPhysicalAuth();
		this.physicalAuthResetGeneration += 1;
	}

	private async runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.lifecycleTail;
		let release: (() => void) | undefined;
		this.lifecycleTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release?.();
		}
	}

	private markStateFatal(operation: ProviderStateFailureOperation, error: Error): void {
		const reason = operation.startsWith("provider_inbox")
			? "provider_inbox_persistence_failed"
			: operation.startsWith("retry_")
				? "provider_retry_state_persistence_failed"
				: "auth_state_persistence_failed";
		this.markFatal(reason, error);
	}

	private markFatal(reason: string, error: Error): void {
		if (this.fatalReason) return;
		this.fatalReason = reason;
		this.status = "disconnected";
		this.lastDisconnectReason = reason;
		this.logger.fatal(
			{ errorType: error.name, reason },
			"WhatsApp provider state failed; stopping",
		);
		const socket = this.socket;
		this.socket = null;
		try {
			const stopping = socket?.end(error);
			if (stopping) {
				void stopping.catch((endError: unknown) => {
					this.logger.error(
						{ errorType: asError(endError).name, reason },
						"WhatsApp provider socket failed while stopping",
					);
				});
			}
		} catch (endError: unknown) {
			this.logger.error(
				{ errorType: asError(endError).name, reason },
				"WhatsApp provider socket failed while stopping",
			);
		}
	}

	private closeState(): void {
		if (this.stateClosed) return;
		this.stateClosed = true;
		this.providerState.close();
	}
}

function disconnectReason(error: unknown): number | undefined {
	if (!isRecord(error)) return undefined;
	const output = error.output;
	if (!isRecord(output)) return undefined;
	const statusCode = output.statusCode;
	return typeof statusCode === "number" ? statusCode : undefined;
}

function isBinaryNode(value: unknown): value is BinaryNode {
	return (
		isRecord(value) &&
		typeof value.tag === "string" &&
		isRecord(value.attrs) &&
		Object.values(value.attrs).every((item) => typeof item === "string")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalEventString(
	value: unknown,
	key: "remoteJidAlt" | "participant" | "participantAlt",
): Partial<Record<typeof key, string>> {
	if (!isRecord(value)) return {};
	const item = value[key];
	return typeof item === "string" && item ? { [key]: item } : {};
}

function messageTimestampField(value: unknown): { messageTimestamp?: number } {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return { messageTimestamp: value };
	}
	if (!isRecord(value)) return {};
	const toNumber = value.toNumber;
	if (typeof toNumber !== "function") return {};
	try {
		const number = Reflect.apply(toNumber, value, []);
		return typeof number === "number" && Number.isSafeInteger(number) && number > 0
			? { messageTimestamp: number }
			: {};
	} catch {
		return {};
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
