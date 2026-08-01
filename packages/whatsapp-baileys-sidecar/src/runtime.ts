import {
	type AnyMessageContent,
	DisconnectReason,
	downloadMediaMessage,
	type MiscMessageGenerationOptions,
	makeWASocket,
	type UserFacingSocketConfig,
	type WAMessage,
	type WAMessageKey,
	type WAPresence,
} from "baileys";
import pino, { type Logger } from "pino";

import { type CallbackDependencies, CallbackJournal } from "./callback.js";
import type { SidecarConfig } from "./config.js";
import { isE164Digits } from "./jid.js";
import { normalizeInboundMessage } from "./normalize.js";
import { SQLiteBaileysState } from "./sqlite-state.js";
import {
	type BaileysRuntime,
	type JidAliasPair,
	MediaNotFoundError,
	MediaTooLargeError,
	MessageNotFoundError,
	type MessageReference,
	OperationConflictError,
	type OperationResult,
	type PairingStatus,
	RuntimeFatalError,
	type RuntimeHealth,
	RuntimeNotConnectedError,
	type SidecarOperation,
	VersionRecoveryRequiredError,
} from "./types.js";

const TRANSIENT_DISCONNECT_REASONS = new Set<number>([
	DisconnectReason.connectionClosed,
	DisconnectReason.connectionLost,
	DisconnectReason.timedOut,
	DisconnectReason.restartRequired,
	DisconnectReason.unavailableService,
]);
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

type ConnectionUpdate = {
	connection?: "open" | "connecting" | "close";
	lastDisconnect?: { error?: Error };
	qr?: string;
};

type MessagesUpsert = { messages: WAMessage[]; type: "append" | "notify"; requestId?: string };

export type SocketLike = {
	ev: {
		on(event: "creds.update", listener: () => void): void;
		on(event: "connection.update", listener: (update: ConnectionUpdate) => void): void;
		on(event: "messages.upsert", listener: (upsert: MessagesUpsert) => void): void;
		removeAllListeners?(event: "creds.update" | "connection.update" | "messages.upsert"): void;
	};
	user?: { id: string; lid?: string; name?: string };
	sendMessage(
		jid: string,
		content: AnyMessageContent,
		options?: MiscMessageGenerationOptions,
	): Promise<WAMessage | undefined>;
	readMessages(keys: WAMessageKey[]): Promise<void>;
	sendPresenceUpdate(type: WAPresence, jid?: string): Promise<void>;
	requestPairingCode(phoneNumber: string): Promise<string>;
	logout(): Promise<void>;
	end(error?: Error): void;
	updateMediaMessage(message: WAMessage): Promise<WAMessage>;
};

export type RuntimeDependencies = {
	makeSocket?: (config: UserFacingSocketConfig) => SocketLike;
	callback?: CallbackDependencies;
	random?: () => number;
	setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
	downloadMedia?: (
		message: WAMessage,
		socket: SocketLike,
		logger: Logger,
	) => Promise<AsyncIterable<Uint8Array>>;
};

export class BaileysSocketRuntime implements BaileysRuntime {
	private socket: SocketLike | null = null;
	private status: RuntimeHealth["status"] = "stopped";
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private lastDisconnectReason: string | undefined;
	private fatalReason: string | undefined;
	private pairing: { method: "qr" | "code"; secret?: string } | undefined;
	private intentionalClose = false;
	private closed = false;
	private readonly startedAt = Date.now();
	private readonly logger: Logger;
	private readonly state: SQLiteBaileysState;
	private readonly callback: CallbackJournal | undefined;
	private readonly activeOperations = new Map<
		string,
		{ hash: string; promise: Promise<OperationResult> }
	>();

	constructor(
		private readonly config: SidecarConfig,
		private readonly dependencies: RuntimeDependencies = {},
	) {
		this.logger = pino({ level: config.logLevel }).child({ accountId: config.accountId });
		this.state = new SQLiteBaileysState(config.accountId, config.sessionDir, config.messageStore);
		if (config.callback) {
			this.callback = new CallbackJournal(
				config.callback,
				this.logger.child({ component: "callback" }),
				() => this.enterFatal("callback_delivery_failed"),
				dependencies.callback,
			);
			try {
				this.handoffPendingCallbacks();
			} catch {
				this.enterFatal("callback_spool_recovery_failed");
			}
		}
	}

	async start(): Promise<void> {
		if (this.closed) throw new Error("runtime has been stopped permanently");
		if (this.status === "fatal") throw new RuntimeFatalError();
		if (this.socket) return;
		await this.openSocket();
	}

	async stop(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.clearReconnectTimer();
		this.endCurrentSocket("sidecar_stopped");
		this.status = "stopped";
		await this.callback?.stop();
		this.state.close();
	}

	health(): RuntimeHealth {
		return {
			status: this.status,
			connected: this.status === "connected",
			uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
			accountId: this.config.accountId,
			advertisedRelease: this.state.persistedRelease(),
			versionRecoveryRequired: !this.state.isReleaseCompatible(),
			registered: this.state.state.creds.registered,
			callback: {
				enabled: Boolean(this.callback),
				pendingEvents: this.callback?.pendingCount() ?? 0,
			},
			...(this.lastDisconnectReason ? { lastDisconnectReason: this.lastDisconnectReason } : {}),
			...(this.fatalReason ? { fatalReason: this.fatalReason } : {}),
		};
	}

	capabilities() {
		return {
			schemaVersion: "clawdi.whatsapp.sidecar-capabilities.v1",
			operations: ["send", "edit", "delete", "reaction", "presence", "read"],
			pairing: ["qr", "code", "cancel", "logout", "recover"],
			mediaDownload: true,
			callbackDelivery: Boolean(this.callback),
			jidKinds: ["pn", "lid", "group"],
			rawProviderAccess: false,
		} as const;
	}

	pairingStatus(): PairingStatus {
		return {
			status: this.status,
			registered: this.state.state.creds.registered,
			...(this.pairing ? { method: this.pairing.method } : {}),
			...(this.pairing?.method === "qr" && this.pairing.secret ? { qr: this.pairing.secret } : {}),
			...(this.pairing?.method === "code" && this.pairing.secret
				? { code: this.pairing.secret }
				: {}),
		};
	}

	async startQrPairing(): Promise<PairingStatus> {
		this.assertPairable();
		this.pairing = { method: "qr" };
		this.endCurrentSocket("pairing_qr_restart");
		await this.openSocket();
		return this.pairingStatus();
	}

	async startCodePairing(phoneNumber: string): Promise<PairingStatus> {
		if (!isE164Digits(phoneNumber)) throw new Error("phoneNumber_must_be_e164_digits");
		this.assertPairable();
		this.pairing = { method: "code" };
		if (!this.socket) await this.openSocket();
		const code = await this.requireSocket(false).requestPairingCode(phoneNumber);
		this.pairing = { method: "code", secret: code };
		this.status = "pairing_code";
		return this.pairingStatus();
	}

	async cancelPairing(): Promise<PairingStatus> {
		this.clearReconnectTimer();
		this.endCurrentSocket("pairing_cancelled");
		this.pairing = undefined;
		if (!this.state.state.creds.registered) {
			this.state.state.creds.pairingCode = undefined;
			try {
				await this.state.saveCreds();
			} catch {
				this.failPersistentState();
			}
		}
		this.status = "stopped";
		return this.pairingStatus();
	}

	async logout(): Promise<PairingStatus> {
		this.clearReconnectTimer();
		const socket = this.socket;
		this.intentionalClose = true;
		try {
			if (socket) await socket.logout();
		} finally {
			if (this.socket === socket) this.endCurrentSocket("logout_local_auth_reset");
			try {
				await this.state.resetLinkedAuth();
			} catch {
				this.failPersistentState();
			}
			this.pairing = undefined;
			this.status = "stopped";
			this.intentionalClose = false;
		}
		return this.pairingStatus();
	}

	async recover(acceptVersionChange: boolean): Promise<void> {
		if (this.closed) throw new Error("runtime has been stopped permanently");
		if (!this.state.isReleaseCompatible()) {
			if (!acceptVersionChange) throw new VersionRecoveryRequiredError();
			try {
				this.state.acceptCurrentRelease();
			} catch {
				this.failPersistentState();
			}
		}
		if (this.callback) {
			try {
				this.callback.recover();
				this.handoffPendingCallbacks();
			} catch {
				this.enterFatal("callback_spool_recovery_failed");
				throw new RuntimeFatalError("callback spool recovery failed; runtime stopped");
			}
		}
		this.clearReconnectTimer();
		this.endCurrentSocket("explicit_recovery");
		this.fatalReason = undefined;
		this.lastDisconnectReason = undefined;
		this.status = "stopped";
		await this.openSocket();
	}

	async performOperation(
		operation: SidecarOperation,
		requestHash: string,
	): Promise<OperationResult> {
		const active = this.activeOperations.get(operation.operationId);
		if (active) {
			if (active.hash !== requestHash) throw new OperationConflictError();
			return await active.promise;
		}
		let reservation: ReturnType<SQLiteBaileysState["reserveOperation"]>;
		try {
			reservation = this.state.reserveOperation(operation.operationId, requestHash);
		} catch (error: unknown) {
			if (error instanceof OperationConflictError) throw error;
			this.failPersistentState();
		}
		if (reservation.action === "return") return reservation.result;
		if (reservation.action === "pending") {
			return {
				operationId: operation.operationId,
				status: "ambiguous",
				error: "provider_outcome_unknown",
			};
		}
		const promise = this.executeOperation(operation, requestHash).finally(() => {
			this.activeOperations.delete(operation.operationId);
		});
		this.activeOperations.set(operation.operationId, { hash: requestHash, promise });
		return await promise;
	}

	async downloadMedia(mediaId: string) {
		const socket = this.requireSocket();
		let stored: ReturnType<SQLiteBaileysState["mediaMessage"]>;
		try {
			stored = this.state.mediaMessage(mediaId);
		} catch {
			this.failPersistentState();
		}
		if (!stored) throw new MediaNotFoundError();
		const stream = await (this.dependencies.downloadMedia ?? defaultDownloadMedia)(
			stored.message,
			socket,
			this.logger,
		);
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of stream) {
			const buffer = Buffer.from(chunk);
			total += buffer.byteLength;
			if (total > this.config.mediaMaxBytes) throw new MediaTooLargeError();
			chunks.push(buffer);
		}
		return {
			data: Buffer.concat(chunks),
			contentType: stored.contentType,
			...(stored.fileName ? { fileName: stored.fileName } : {}),
		};
	}

	private async executeOperation(
		operation: SidecarOperation,
		requestHash: string,
	): Promise<OperationResult> {
		let socket: SocketLike;
		try {
			socket = this.requireSocket();
		} catch (error: unknown) {
			if (error instanceof RuntimeNotConnectedError) {
				return this.persistFailedOperation(
					operation.operationId,
					requestHash,
					"baileys_not_connected",
				);
			}
			throw error;
		}
		if (operation.type === "presence") {
			try {
				await socket.sendPresenceUpdate(
					operation.presence,
					operation.presence === "available" || operation.presence === "unavailable"
						? undefined
						: operation.chatJid,
				);
			} catch {
				return this.persistAmbiguousOperation(operation.operationId, requestHash);
			}
			return this.completeWithoutMessage(operation.operationId, requestHash);
		}
		if (operation.type === "read") {
			try {
				await socket.readMessages(
					operation.messages.map((reference) => keyFromReference(reference, operation.chatJid)),
				);
			} catch {
				return this.persistAmbiguousOperation(operation.operationId, requestHash);
			}
			return this.completeWithoutMessage(operation.operationId, requestHash);
		}
		let prepared: { content: AnyMessageContent; options: MiscMessageGenerationOptions };
		try {
			prepared = this.buildMessageOperation(operation);
		} catch (error: unknown) {
			if (error instanceof MessageNotFoundError) {
				return this.persistFailedOperation(
					operation.operationId,
					requestHash,
					"referenced_message_not_found",
				);
			}
			this.failPersistentState();
		}
		let sent: WAMessage | undefined;
		try {
			sent = await socket.sendMessage(operation.chatJid, prepared.content, prepared.options);
		} catch {
			return this.persistAmbiguousOperation(operation.operationId, requestHash);
		}
		if (!sent?.message || !sent.key.id) {
			return this.persistAmbiguousOperation(operation.operationId, requestHash);
		}
		const result: OperationResult = {
			operationId: operation.operationId,
			status: "completed",
			messageId: sent.key.id,
		};
		try {
			this.state.completeOperation(operation.operationId, requestHash, result, sent);
		} catch {
			this.failPersistentState();
		}
		return result;
	}

	private buildMessageOperation(
		operation: Exclude<SidecarOperation, { type: "presence" | "read" }>,
	): { content: AnyMessageContent; options: MiscMessageGenerationOptions } {
		const options: MiscMessageGenerationOptions = { messageId: operation.messageId };
		if (operation.type === "send") {
			if (operation.replyTo) {
				const quoted = this.state.findQuotedMessage(operation.replyTo, operation.chatJid);
				if (!quoted) throw new MessageNotFoundError();
				options.quoted = quoted;
			}
			if (operation.content.type === "text") {
				return { content: { text: operation.content.text }, options };
			}
			const data = Buffer.from(operation.content.dataBase64, "base64");
			const common = {
				mimetype: operation.content.mimeType,
				...(operation.content.caption ? { caption: operation.content.caption } : {}),
			};
			if (operation.content.mediaType === "image") {
				return { content: { image: data, ...common }, options };
			}
			if (operation.content.mediaType === "video") {
				return { content: { video: data, ...common }, options };
			}
			if (operation.content.mediaType === "audio") {
				return { content: { audio: data, mimetype: operation.content.mimeType }, options };
			}
			return {
				content: {
					document: data,
					...common,
					...(operation.content.fileName ? { fileName: operation.content.fileName } : {}),
				},
				options,
			};
		}
		const key = keyFromReference(operation.target, operation.chatJid);
		if (operation.type === "edit") return { content: { text: operation.text, edit: key }, options };
		if (operation.type === "delete") return { content: { delete: key }, options };
		return { content: { react: { key, text: operation.reaction } }, options };
	}

	private completeWithoutMessage(operationId: string, requestHash: string): OperationResult {
		const result: OperationResult = { operationId, status: "completed" };
		try {
			this.state.completeOperation(operationId, requestHash, result);
		} catch {
			this.failPersistentState();
		}
		return result;
	}

	private persistAmbiguousOperation(operationId: string, requestHash: string): OperationResult {
		try {
			return this.state.markOperationAmbiguous(operationId, requestHash);
		} catch {
			this.failPersistentState();
		}
	}

	private persistFailedOperation(
		operationId: string,
		requestHash: string,
		error: string,
	): OperationResult {
		try {
			return this.state.markOperationFailed(operationId, requestHash, error);
		} catch {
			this.failPersistentState();
		}
	}

	private async openSocket(): Promise<void> {
		if (this.socket) return;
		try {
			this.state.assertReleaseCompatible();
		} catch (error: unknown) {
			this.enterFatal("version_recovery_required");
			throw error;
		}
		this.status = "starting";
		const release = this.state.persistedRelease();
		const socket = (this.dependencies.makeSocket ?? defaultMakeSocket)({
			version: [...release.version],
			auth: this.state.state,
			logger: this.logger.child({ component: "baileys" }),
			printQRInTerminal: false,
			syncFullHistory: false,
			markOnlineOnConnect: false,
			getMessage: async (key) => await this.state.getMessage(key),
			shouldIgnoreJid: (jid) => !isIngressJidSupported(jid),
		});
		if (this.socket) {
			socket.end(new Error("unique socket ownership violation"));
			this.enterFatal("unique_socket_violation");
			throw new Error("runtime attempted to own more than one WASocket");
		}
		this.socket = socket;
		this.intentionalClose = false;
		this.attachSocket(socket);
	}

	private attachSocket(socket: SocketLike): void {
		socket.ev.on("creds.update", () => {
			this.state.saveCreds().catch(() => this.enterFatal("persistent_state_failure"));
		});
		socket.ev.on("messages.upsert", (upsert) => {
			if (this.socket !== socket || this.status === "fatal") return;
			try {
				for (const message of upsert.messages) {
					if (upsert.type !== "notify") {
						if (message.message) this.state.storeMessage(message);
						continue;
					}
					const event = normalizeInboundMessage(
						message,
						this.config.accountId,
						selfAliases(socket),
					);
					if (!event) continue;
					this.state.storeInbound(event, message, Boolean(this.callback));
					if (this.callback) {
						this.callback.enqueue(event);
						this.state.markCallbackEventSpooled(event.providerEventId);
					}
				}
			} catch {
				this.enterFatal("persistent_ingress_failure");
			}
		});
		socket.ev.on("connection.update", (update) => {
			if (this.socket !== socket) return;
			if (update.qr && !this.state.state.creds.registered && this.pairing?.method !== "code") {
				this.pairing = { method: "qr", secret: update.qr };
				this.status = "pairing_qr";
			}
			if (update.connection === "open") {
				this.status = "connected";
				this.pairing = undefined;
				this.lastDisconnectReason = undefined;
				this.reconnectAttempt = 0;
				this.logger.info("WhatsApp socket connected");
				return;
			}
			if (update.connection !== "close") return;
			if (this.socket === socket) this.socket = null;
			const reason = disconnectReason(update.lastDisconnect?.error);
			this.lastDisconnectReason = reason === undefined ? "unknown" : String(reason);
			if (this.intentionalClose) return;
			if (reason === DisconnectReason.loggedOut) {
				this.enterFatal("logged_out");
				return;
			}
			if (shouldReconnectAfterClose(false, reason)) {
				this.status = "disconnected";
				this.scheduleReconnect();
				return;
			}
			this.enterFatal("non_transient_disconnect");
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.status === "fatal" || this.closed) return;
		const delay = reconnectDelayMs(
			this.reconnectAttempt,
			(this.dependencies.random ?? Math.random)(),
		);
		this.reconnectAttempt += 1;
		const setTimer = this.dependencies.setTimer ?? setTimeout;
		this.reconnectTimer = setTimer(() => {
			this.reconnectTimer = undefined;
			this.openSocket().catch(() => {
				if (this.status !== "fatal") {
					this.status = "disconnected";
					this.scheduleReconnect();
				}
			});
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (!this.reconnectTimer) return;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	private endCurrentSocket(reason: string): void {
		const socket = this.socket;
		if (!socket) return;
		this.intentionalClose = true;
		this.socket = null;
		socket.ev.removeAllListeners?.("creds.update");
		socket.ev.removeAllListeners?.("connection.update");
		socket.ev.removeAllListeners?.("messages.upsert");
		socket.end(new Error(reason));
		this.intentionalClose = false;
	}

	private enterFatal(reason: string): void {
		if (this.status === "fatal") return;
		this.clearReconnectTimer();
		this.fatalReason = reason;
		this.status = "fatal";
		this.endCurrentSocket("fail_stop");
		this.logger.fatal({ reason }, "WhatsApp runtime entered fail-stop");
	}

	private failPersistentState(): never {
		this.enterFatal("persistent_state_failure");
		throw new RuntimeFatalError("persistent sidecar state failed; runtime stopped");
	}

	private handoffPendingCallbacks(): void {
		if (!this.callback) return;
		for (const event of this.state.pendingCallbackEvents()) {
			this.callback.enqueue(event);
			this.state.markCallbackEventSpooled(event.providerEventId);
		}
	}

	private assertPairable(): void {
		if (this.status === "fatal") throw new RuntimeFatalError();
		if (this.state.state.creds.registered) throw new Error("account_already_linked");
	}

	private requireSocket(requireConnected = true): SocketLike {
		if (this.status === "fatal") throw new RuntimeFatalError();
		if (!this.socket || (requireConnected && this.status !== "connected")) {
			throw new RuntimeNotConnectedError();
		}
		return this.socket;
	}
}

export function shouldReconnectAfterClose(
	fatalStateFailure: boolean,
	disconnectReasonCode: number | undefined,
): boolean {
	return (
		!fatalStateFailure &&
		disconnectReasonCode !== undefined &&
		TRANSIENT_DISCONNECT_REASONS.has(disconnectReasonCode)
	);
}

export function reconnectDelayMs(attempt: number, randomValue = Math.random()): number {
	const boundedAttempt = Math.max(0, Math.min(Math.floor(attempt), 16));
	const exponential = Math.min(
		RECONNECT_MAX_DELAY_MS,
		RECONNECT_BASE_DELAY_MS * 2 ** boundedAttempt,
	);
	const jitter = 0.5 + Math.max(0, Math.min(randomValue, 1)) / 2;
	return Math.round(exponential * jitter);
}

function keyFromReference(reference: MessageReference, defaultChatJid: string): WAMessageKey {
	return {
		remoteJid: reference.chatJid ?? defaultChatJid,
		remoteJidAlt: reference.chatJidAlt,
		id: reference.messageId,
		fromMe: reference.fromMe,
		participant: reference.participantJid,
		participantAlt: reference.participantJidAlt,
	};
}

function selfAliases(socket: SocketLike): JidAliasPair | undefined {
	if (!socket.user?.id) return undefined;
	return { primary: socket.user.id, ...(socket.user.lid ? { alt: socket.user.lid } : {}) };
}

function isIngressJidSupported(jid: string): boolean {
	return (
		/^([1-9][0-9]{0,19})@(s\.whatsapp\.net|lid)$/.test(jid) ||
		/^([0-9]{5,30}(?:-[0-9]{1,30})?)@g\.us$/.test(jid)
	);
}

function disconnectReason(error: unknown): number | undefined {
	if (!isRecord(error) || !isRecord(error.output)) return undefined;
	return typeof error.output.statusCode === "number" ? error.output.statusCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultMakeSocket(config: UserFacingSocketConfig): SocketLike {
	return makeWASocket(config);
}

async function defaultDownloadMedia(
	message: WAMessage,
	socket: SocketLike,
	logger: Logger,
): Promise<AsyncIterable<Uint8Array>> {
	return await downloadMediaMessage(
		message,
		"stream",
		{},
		{
			reuploadRequest: async (value) => await socket.updateMediaMessage(value),
			logger,
		},
	);
}
