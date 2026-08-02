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

import type { SidecarConfig } from "./config.js";
import {
	type ProviderMessageEvent,
	type ProviderMessageEventInput,
	type ProviderStateFailureOperation,
	SQLiteProviderState,
} from "./sqlite-state.js";
import {
	type BaileysRuntime,
	type RelayMessageRequest,
	type RuntimeHealth,
	RuntimeNotConnectedError,
	type RuntimeStatus,
} from "./types.js";

const RECONNECT_DELAY_MS = 3_000;
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

type ProviderSocket = Pick<WASocket, "user" | "end" | "relayMessage" | "sendNode" | "query"> & {
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
	storeRetryMessage(remoteJid: string, messageId: string, message: Uint8Array): void;
	getRetryMessage(
		remoteJid: string | null | undefined,
		messageId: string | null | undefined,
	): proto.IMessage | undefined;
	appendProviderEvents(events: readonly ProviderMessageEventInput[]): void;
	providerEvents(limit: number): ProviderMessageEvent[];
	acknowledgeProviderEvents(throughSequence: number): void;
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
	private readonly providerState: ProviderState;
	private readonly socketFactory: ProviderSocketFactory;
	private stateClosed = false;

	constructor(
		private readonly config: SidecarConfig,
		dependencies: BaileysRuntimeDependencies = {},
	) {
		this.logger = pino({ level: config.logLevel });
		this.socketFactory = dependencies.socketFactory ?? defaultProviderSocketFactory;
		this.providerState =
			dependencies.providerState ??
			new SQLiteProviderState(
				config.sessionDir,
				config.accountId,
				config.webVersion,
				config.providerInbox,
				(operation, error) => this.markStateFatal(operation, error),
			);
	}

	async start(): Promise<void> {
		if (this.fatalReason) {
			throw new Error(`WhatsApp provider requires operator recovery: ${this.fatalReason}`);
		}
		if (this.stateClosed) throw new Error("WhatsApp provider state is closed");
		if (this.status === "connected" || this.status === "connecting" || this.status === "starting") {
			return;
		}
		this.status = "starting";
		try {
			await this.openSocket();
		} catch (error: unknown) {
			this.status = "stopped";
			this.closeState();
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
		};
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
		this.status = "connecting";
		const socket = this.socketFactory({
			version: this.config.webVersion,
			auth: this.providerState.state,
			logger: this.logger.child({ component: "baileys" }),
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
			if (qr) this.logger.warn("WhatsApp pairing QR emitted by physical provider transport");
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
			if (reason !== undefined && TRANSIENT_DISCONNECT_REASONS.has(reason)) {
				this.scheduleReconnect();
				return;
			}
			this.fatalReason =
				reason === DisconnectReason.loggedOut ? "provider_logged_out" : "non_transient_disconnect";
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
