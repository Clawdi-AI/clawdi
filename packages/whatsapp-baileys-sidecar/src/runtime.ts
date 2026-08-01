import {
	type BaileysEventMap,
	type BinaryNode,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeWASocket,
	proto,
	type WAMessage,
	type WASocket,
} from "baileys";
import pino, { type Logger } from "pino";
import * as qrcodeTerminal from "qrcode-terminal";

import { CallbackQueueFullError, ClawdiCallbackDeliveryQueue } from "./callback.js";
import type { SidecarConfig } from "./config.js";
import { normalizeInboundMessage } from "./normalize.js";
import { SQLiteBaileysState } from "./sqlite-state.js";
import {
	type BaileysRuntime,
	QuotedMessageNotFoundError,
	type RelayMessageRequest,
	type RuntimeHealth,
	RuntimeNotConnectedError,
	type RuntimeStatus,
	type SendTextMessageRequest,
	type SendTextMessageResult,
} from "./types.js";

const RECONNECT_BASE_DELAY_MS = 3_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const TRANSIENT_DISCONNECT_REASONS = new Set<number>([
	DisconnectReason.connectionClosed,
	DisconnectReason.connectionLost,
	DisconnectReason.restartRequired,
	DisconnectReason.unavailableService,
]);

export class BaileysSocketRuntime implements BaileysRuntime {
	private socket: WASocket | null = null;
	private status: RuntimeStatus = "stopped";
	private lastDisconnectReason: string | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly startedAt = Date.now();
	private readonly logger: Logger;
	private readonly callbackQueue: ClawdiCallbackDeliveryQueue | null;
	private readonly backpressuredSockets = new WeakSet<WASocket>();
	private readonly fatalSockets = new WeakSet<WASocket>();
	private readonly shutdown = new AbortController();
	private readonly providerState: SQLiteBaileysState;
	private fatalReason: string | undefined;
	private pairingQr: string | undefined;
	private pairingCode: string | undefined;
	private reconnectAttempt = 0;

	constructor(private readonly config: SidecarConfig) {
		this.logger = pino({ level: config.logLevel });
		this.callbackQueue = config.callback
			? new ClawdiCallbackDeliveryQueue(config.callback, this.logger)
			: null;
		this.providerState = new SQLiteBaileysState(config.sessionDir, config.messageStore);
	}

	async start(): Promise<void> {
		if (this.fatalReason) {
			throw new Error(
				`WhatsApp sidecar requires operator restart after fatal state: ${this.fatalReason}`,
			);
		}
		if (this.status === "connected" || this.status === "connecting" || this.status === "starting") {
			return;
		}
		this.status = "starting";
		await this.openSocket();
	}

	async stop(): Promise<void> {
		this.shutdown.abort();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		const socket = this.socket;
		this.socket = null;
		this.status = "stopped";
		if (socket) {
			socket.end(new Error("Clawdi Baileys sidecar stopped"));
		}
		const queuedCallbackEvents = await this.callbackQueue?.stop();
		const pendingCallbackEvents = queuedCallbackEvents ?? 0;
		if (pendingCallbackEvents) {
			this.logger.error(
				{ pendingCallbackEvents },
				"WhatsApp sidecar stopped with undelivered callback events",
			);
		}
		this.providerState.close();
	}

	async sendTextMessage(request: SendTextMessageRequest): Promise<SendTextMessageResult> {
		const socket = this.requireSocket();
		const accountJid = socket.user?.id ?? this.providerState.state.creds.me?.id;
		const quoted = await resolveQuotedMessage(this.providerState, accountJid, request);
		const sent = await sendTextThroughSocket(socket, request, quoted);
		const { messageId, retryStoreError } = recordProviderSentMessage(
			this.providerState,
			accountJid,
			sent,
		);
		if (retryStoreError) {
			this.markProviderStateFatal(
				socket,
				"retry_message_persistence_failed",
				retryStoreError,
				"WhatsApp provider succeeded but retry-message persistence failed; stopping provider socket",
				{ messageId },
			);
		}
		return { messageId };
	}

	health(): RuntimeHealth {
		const user = this.socket?.user
			? {
					id: this.socket.user.id,
					name: this.socket.user.name,
				}
			: undefined;
		return {
			status: this.status,
			connected: this.status === "connected",
			uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
			...(user ? { user } : {}),
			...(this.lastDisconnectReason ? { lastDisconnectReason: this.lastDisconnectReason } : {}),
			...(this.callbackQueue
				? {
						pendingCallbackEvents: this.callbackQueue.pendingCount(),
					}
				: {}),
			...(this.pairingCode
				? { pairing: { method: "code" as const, value: this.pairingCode } }
				: this.pairingQr
					? { pairing: { method: "qr" as const, value: this.pairingQr } }
					: {}),
		};
	}

	async relayMessage(request: RelayMessageRequest): Promise<string | undefined> {
		const socket = this.requireSocket();
		const message = proto.Message.decode(request.messageProto);
		return await socket.relayMessage(request.jid, message, {
			messageId: request.messageId,
			additionalAttributes: request.additionalAttributes,
		});
	}

	async sendNode(node: BinaryNode): Promise<void> {
		await this.requireSocket().sendNode(node);
	}

	async query(node: BinaryNode, timeoutMs: number): Promise<BinaryNode | null> {
		const response = await this.requireSocket().query(node, timeoutMs);
		if (!isBinaryNode(response)) {
			return null;
		}
		return response;
	}

	private async openSocket(): Promise<void> {
		this.status = "connecting";
		const { version } = await fetchLatestBaileysVersion();
		const socket = makeWASocket({
			version,
			auth: this.providerState.state,
			logger: this.logger.child({ component: "baileys" }),
			syncFullHistory: false,
			markOnlineOnConnect: false,
			getMessage: async (key) =>
				this.providerState.getMessage(
					socket.user?.id ?? this.providerState.state.creds.me?.id,
					key,
				),
			...(this.config.waWebSocketUrl ? { waWebSocketUrl: this.config.waWebSocketUrl } : {}),
			...(this.config.authCert ? { authCert: this.config.authCert } : {}),
		});
		this.socket = socket;
		socket.ev.on("creds.update", () => {
			this.providerState.saveCreds().catch((error: unknown) => {
				this.fatalSockets.add(socket);
				this.fatalReason = "auth_state_persistence_failed";
				this.status = "disconnected";
				this.lastDisconnectReason = this.fatalReason;
				this.logger.fatal(
					{ error },
					"WhatsApp auth state persistence failed; stopping provider socket",
				);
				socket.end(error instanceof Error ? error : new Error(String(error)));
			});
		});
		if (this.callbackQueue) {
			registerBaileysInboundCallbackListener(
				{ onMessagesUpsert: (listener) => socket.ev.on("messages.upsert", listener) },
				this.callbackQueue,
				{
					isActive: () => this.socket === socket,
					persistRetryMessages: (messages) => {
						const accountJid = socket.user?.id ?? this.providerState.state.creds.me?.id;
						if (!accountJid) {
							throw new Error("WhatsApp account identity unavailable for retry store");
						}
						const persisted = this.providerState.storeMessages(
							accountJid,
							messages.map((message) => ({ key: message.key, message: message.message })),
						);
						if (persisted !== messages.length) {
							throw new Error("WhatsApp retry store did not persist the complete batch");
						}
					},
					onRetryStoreFailure: (error) => {
						this.fatalSockets.add(socket);
						this.status = "disconnected";
						this.fatalReason = "retry_message_persistence_failed";
						this.lastDisconnectReason = this.fatalReason;
						this.logger.fatal(
							{ error },
							"WhatsApp retry-message persistence failed; stopping provider socket",
						);
						socket.end(error);
					},
					onBackpressure: (error, providerEventId, eventCount) => {
						const fatalReason =
							error instanceof CallbackQueueFullError
								? "callback_spool_capacity_exceeded"
								: "callback_spool_persistence_failed";
						this.logger.error(
							{ error, providerEventId, eventCount, fatalReason },
							"WhatsApp callback spool rejected a provider batch; operator restart required",
						);
						if (this.backpressuredSockets.has(socket)) return;
						this.backpressuredSockets.add(socket);
						this.fatalSockets.add(socket);
						this.fatalReason = fatalReason;
						this.status = "disconnected";
						this.lastDisconnectReason = this.fatalReason;
						socket.end(error);
					},
				},
			);
		}
		socket.ev.on("connection.update", (update) => {
			if (this.socket !== socket) return;
			const { connection, lastDisconnect, qr } = update;
			const fatalStateFailure = this.fatalSockets.has(socket);
			if (fatalStateFailure && connection !== "close") return;
			if (qr && !this.config.pairingPhoneNumber) {
				this.pairingQr = qr;
				this.pairingCode = undefined;
				qrcodeTerminal.generate(qr, { small: true }, (rendered) => {
					process.stderr.write(
						`\nScan this WhatsApp pairing QR on the primary phone:\n${rendered}\n`,
					);
				});
				this.logger.warn("WhatsApp pairing QR rendered on the physical sidecar terminal");
			}
			if (connection === "open") {
				this.status = "connected";
				this.lastDisconnectReason = undefined;
				this.pairingQr = undefined;
				this.pairingCode = undefined;
				this.reconnectAttempt = 0;
				this.logger.info("WhatsApp connected");
				return;
			}
			if (connection === "close") {
				this.status = "disconnected";
				this.socket = null;
				this.pairingQr = undefined;
				this.pairingCode = undefined;
				const reason = disconnectReason(lastDisconnect?.error);
				this.lastDisconnectReason = fatalStateFailure
					? this.fatalReason
					: reason
						? String(reason)
						: undefined;
				this.logger.warn({ reason }, "WhatsApp connection closed");
				if (shouldReconnectAfterClose(fatalStateFailure, reason)) {
					this.scheduleReconnect();
				}
			}
		});
		if (!this.providerState.state.creds.registered && this.config.pairingPhoneNumber) {
			try {
				const code = await socket.requestPairingCode(this.config.pairingPhoneNumber);
				if (this.socket === socket) {
					this.pairingCode = code;
					this.pairingQr = undefined;
					process.stderr.write(`\nWhatsApp pairing code: ${code}\n`);
					this.logger.warn(
						"WhatsApp manual pairing code rendered on the physical sidecar terminal",
					);
				}
			} catch (error: unknown) {
				if (this.socket === socket) this.socket = null;
				socket.end(error instanceof Error ? error : new Error(String(error)));
				throw error;
			}
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.status === "stopped") {
			return;
		}
		const delayMs = reconnectDelayMs(this.reconnectAttempt);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = undefined;
			if (this.status === "stopped") return;
			this.openSocket().catch((error: unknown) => {
				this.status = "disconnected";
				this.lastDisconnectReason = error instanceof Error ? error.message : String(error);
				this.logger.error({ error }, "WhatsApp reconnect failed");
				this.scheduleReconnect();
			});
		}, delayMs);
	}

	private requireSocket(): WASocket {
		if (!this.socket || this.status !== "connected") {
			throw new RuntimeNotConnectedError();
		}
		return this.socket;
	}

	private markProviderStateFatal(
		socket: WASocket,
		reason: string,
		error: Error,
		message: string,
		context: Record<string, unknown> = {},
	): void {
		this.fatalSockets.add(socket);
		this.fatalReason = reason;
		this.status = "disconnected";
		this.lastDisconnectReason = reason;
		this.logger.fatal({ ...context, error }, message);
		socket.end(error);
	}
}

type TextSocket = {
	sendMessage(
		jid: string,
		content: { text: string },
		options: { messageId: string; quoted?: WAMessage },
	): Promise<WAMessage | undefined>;
};

export async function sendTextThroughSocket(
	socket: TextSocket,
	request: SendTextMessageRequest,
	quoted?: WAMessage,
): Promise<WAMessage> {
	const sent = await socket.sendMessage(
		request.jid,
		{ text: request.text },
		{
			messageId: request.messageId,
			...(quoted ? { quoted } : {}),
		},
	);
	if (!sent) throw new Error("Baileys sendMessage returned no message");
	return sent;
}

export function recordProviderSentMessage(
	store: Pick<SQLiteBaileysState, "storeMessage">,
	accountJid: string | undefined,
	sent: WAMessage,
): { messageId: string; retryStoreError?: Error } {
	const messageId = sent.key.id?.trim();
	if (!messageId) {
		throw new Error("Baileys sendMessage returned no message id");
	}
	try {
		const persisted = store.storeMessage(accountJid, sent.key, sent.message);
		if (!persisted) {
			throw new Error("WhatsApp retry store rejected the outbound message");
		}
		return { messageId };
	} catch (error: unknown) {
		return {
			messageId,
			retryStoreError: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

type MessagesUpsert = BaileysEventMap["messages.upsert"];

export type BaileysInboundCallbackSource = {
	onMessagesUpsert(listener: (upsert: MessagesUpsert) => void): void;
};

export async function resolveQuotedMessage(
	store: Pick<SQLiteBaileysState, "getMessage">,
	accountJid: string | undefined,
	request: SendTextMessageRequest,
): Promise<WAMessage | undefined> {
	if (!request.replyTo) return undefined;
	const key: WAMessage["key"] = {
		id: request.replyTo.messageId,
		remoteJid: request.jid,
		fromMe: false,
		...(request.replyTo.participantJid ? { participant: request.replyTo.participantJid } : {}),
	};
	const message = await store.getMessage(accountJid, key);
	if (!message) throw new QuotedMessageNotFoundError();
	return { key, message };
}

export function registerBaileysInboundCallbackListener(
	source: BaileysInboundCallbackSource,
	queue: ClawdiCallbackDeliveryQueue,
	callbacks: {
		isActive: () => boolean;
		persistRetryMessages?: (messages: readonly WAMessage[]) => void;
		onRetryStoreFailure?: (error: Error) => void;
		onBackpressure: (error: Error, providerEventId: string | undefined, eventCount: number) => void;
	},
): void {
	source.onMessagesUpsert((upsert) => {
		if (!callbacks.isActive()) return;
		if (upsert.type !== "notify") return;
		const normalized = upsert.messages.flatMap((message) => {
			const event = normalizeInboundMessage(message, {
				upsertType: upsert.type,
				...(upsert.requestId ? { requestId: upsert.requestId } : {}),
			});
			return event ? [{ event, message }] : [];
		});
		const events = normalized.map(({ event }) => event);
		if (events.length === 0) return;
		let retryStoreError: Error | undefined;
		try {
			callbacks.persistRetryMessages?.(normalized.map(({ message }) => message));
		} catch (error: unknown) {
			retryStoreError = error instanceof Error ? error : new Error(String(error));
		}
		if (retryStoreError) {
			callbacks.onRetryStoreFailure?.(retryStoreError);
			return;
		}
		try {
			queue.enqueueBatch(events);
		} catch (error: unknown) {
			callbacks.onBackpressure(
				error instanceof Error ? error : new CallbackQueueFullError(),
				events[0]?.providerEventId,
				events.length,
			);
			return;
		}
	});
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
	const boundedAttempt = Math.max(0, Math.min(Math.floor(attempt), 10));
	const exponentialDelay = Math.min(
		RECONNECT_MAX_DELAY_MS,
		RECONNECT_BASE_DELAY_MS * 2 ** boundedAttempt,
	);
	const boundedRandom = Math.max(0, Math.min(randomValue, 1));
	return Math.round(exponentialDelay * (0.5 + boundedRandom / 2));
}

function disconnectReason(error: unknown): number | undefined {
	if (!isRecord(error)) {
		return undefined;
	}
	const output = error.output;
	if (!isRecord(output)) {
		return undefined;
	}
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
