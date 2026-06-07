import {
	type BinaryNode,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeWASocket,
	proto,
	useMultiFileAuthState,
	type WASocket,
} from "baileys";
import pino, { type Logger } from "pino";

import type { SidecarConfig } from "./config.js";
import {
	type BaileysRuntime,
	type RelayMessageRequest,
	type RuntimeHealth,
	RuntimeNotConnectedError,
	type RuntimeStatus,
} from "./types.js";

export class BaileysSocketRuntime implements BaileysRuntime {
	private socket: WASocket | null = null;
	private status: RuntimeStatus = "stopped";
	private lastDisconnectReason: string | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly startedAt = Date.now();
	private readonly logger: Logger;

	constructor(private readonly config: SidecarConfig) {
		this.logger = pino({ level: config.logLevel });
	}

	async start(): Promise<void> {
		if (this.status === "connected" || this.status === "connecting" || this.status === "starting") {
			return;
		}
		this.status = "starting";
		await this.openSocket();
	}

	async stop(): Promise<void> {
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
		const { state, saveCreds } = await useMultiFileAuthState(this.config.sessionDir);
		const { version } = await fetchLatestBaileysVersion();
		const socket = makeWASocket({
			version,
			auth: state,
			logger: this.logger.child({ component: "baileys" }),
			printQRInTerminal: false,
			syncFullHistory: false,
			markOnlineOnConnect: false,
			getMessage: async () => ({ conversation: "" }),
			...(this.config.waWebSocketUrl ? { waWebSocketUrl: this.config.waWebSocketUrl } : {}),
			...(this.config.authCert ? { authCert: this.config.authCert } : {}),
		});
		this.socket = socket;
		socket.ev.on("creds.update", saveCreds);
		socket.ev.on("connection.update", (update) => {
			const { connection, lastDisconnect, qr } = update;
			if (qr) {
				this.logger.warn({ qr }, "WhatsApp pairing QR emitted");
			}
			if (connection === "open") {
				this.status = "connected";
				this.lastDisconnectReason = undefined;
				this.logger.info("WhatsApp connected");
				return;
			}
			if (connection === "close") {
				this.status = "disconnected";
				const reason = disconnectReason(lastDisconnect?.error);
				this.lastDisconnectReason = reason ? String(reason) : undefined;
				this.logger.warn({ reason }, "WhatsApp connection closed");
				if (reason !== DisconnectReason.loggedOut) {
					this.scheduleReconnect();
				}
			}
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) {
			return;
		}
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.openSocket().catch((error: unknown) => {
				this.status = "disconnected";
				this.lastDisconnectReason = error instanceof Error ? error.message : String(error);
				this.logger.error({ error }, "WhatsApp reconnect failed");
				this.scheduleReconnect();
			});
		}, 3000);
	}

	private requireSocket(): WASocket {
		if (!this.socket || this.status !== "connected") {
			throw new RuntimeNotConnectedError();
		}
		return this.socket;
	}
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
