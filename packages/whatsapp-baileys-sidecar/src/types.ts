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
};

export type RelayMessageRequest = {
	jid: string;
	messageId: string;
	messageProto: Uint8Array;
	additionalAttributes: Record<string, string>;
};

export type BaileysRuntime = {
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): RuntimeHealth;
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
