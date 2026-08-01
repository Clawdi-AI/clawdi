import type { BinaryNode } from "baileys";

export type RuntimeStatus = "starting" | "connecting" | "connected" | "disconnected" | "stopped";

export type RuntimeHealth = {
	status: RuntimeStatus;
	connected: boolean;
	uptimeSeconds: number;
	user?: {
		id?: string;
		name?: string;
	};
	lastDisconnectReason?: string;
	pendingCallbackEvents?: number;
};

export type RelayMessageRequest = {
	jid: string;
	messageId: string;
	messageProto: Uint8Array;
	additionalAttributes: Record<string, string>;
};

export type SendTextMessageRequest = {
	jid: string;
	text: string;
	messageId: string;
	replyTo?: {
		messageId: string;
		participantJid?: string;
	};
};

export type SendTextMessageResult = {
	messageId: string;
};

export type NormalizedInboundMessage = {
	schemaVersion: "clawdi.whatsapp.sidecar-event.v1";
	providerEventId: string;
	messageId: string;
	chatJid: string;
	chatJidAlt?: string;
	actorJid: string;
	actorJidAlt?: string;
	fromMe: false;
	text: string;
	pushName?: string;
	timestamp?: number;
};

export type BaileysRuntime = {
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): RuntimeHealth;
	sendTextMessage(request: SendTextMessageRequest): Promise<SendTextMessageResult>;
	relayMessage(request: RelayMessageRequest): Promise<string | undefined>;
	sendNode(node: BinaryNode): Promise<void>;
	query(node: BinaryNode, timeoutMs: number): Promise<BinaryNode | null>;
};

export class RuntimeNotConnectedError extends Error {
	constructor() {
		super("Baileys socket is not connected");
		this.name = "RuntimeNotConnectedError";
	}
}

export class QuotedMessageNotFoundError extends Error {
	constructor() {
		super("Quoted WhatsApp message was not found in the sidecar retry store");
		this.name = "QuotedMessageNotFoundError";
	}
}
