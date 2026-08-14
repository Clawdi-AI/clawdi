import type { BinaryNode } from "baileys";
import type { ProviderMessageEvent } from "./sqlite-state.js";

export type RuntimeStatus =
	| "starting"
	| "connecting"
	| "pairing_qr"
	| "pairing_code"
	| "connected"
	| "disconnected"
	| "stopped";

export type RuntimeHealth = {
	status: RuntimeStatus;
	connected: boolean;
	registered: boolean;
	sessionId: string;
	advertisedRelease: {
		packageName: string;
		packageVersion: string;
		sourceCommit: string;
		version: readonly [number, number, number];
	};
	uptimeSeconds: number;
	user?: {
		id?: string;
		lid?: string;
		name?: string;
	};
	lastDisconnectReason?: string;
};

export type PairingStatus = {
	status: "starting" | "pairing_qr" | "pairing_code" | "connected" | "disconnected" | "stopped";
	registered: boolean;
	method?: "qr" | "code";
	qr?: string;
	qrExpiresAt?: string;
	code?: string;
};

export type SidecarCapabilities = {
	schemaVersion: "clawdi.whatsapp.sidecar-capabilities.v1";
	pairing: readonly ["qr", "code", "cancel", "logout", "retry", "recover"];
	rawProviderAccess: false;
};

export const SIDECAR_CAPABILITIES: SidecarCapabilities = {
	schemaVersion: "clawdi.whatsapp.sidecar-capabilities.v1",
	pairing: ["qr", "code", "cancel", "logout", "retry", "recover"],
	rawProviderAccess: false,
};

export type RelayMessageRequest = {
	jid: string;
	messageId: string;
	messageProto: Uint8Array;
	additionalAttributes: Record<string, string>;
	additionalNodes: BinaryNode[];
};

export type BaileysRuntime = {
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): RuntimeHealth;
	capabilities(): SidecarCapabilities;
	pairingStatus(): PairingStatus;
	startQrPairing(): Promise<PairingStatus>;
	requestPairingCode(phoneNumber: string): Promise<PairingStatus>;
	cancelPairing(): Promise<PairingStatus>;
	logoutPairing(): Promise<PairingStatus>;
	retryPairing(): Promise<PairingStatus>;
	recoverPairing(): Promise<PairingStatus>;
	relayMessage(request: RelayMessageRequest): Promise<string | undefined>;
	sendNode(node: BinaryNode): Promise<void>;
	query(node: BinaryNode, timeoutMs: number): Promise<BinaryNode | null>;
	providerEvents(limit: number): ProviderMessageEvent[];
	waitForProviderEvents(limit: number, waitMs: number): Promise<ProviderMessageEvent[]>;
	acknowledgeProviderEvents(throughSequence: number): void;
};

export class PairingLifecycleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PairingLifecycleError";
	}
}

export class RuntimeNotConnectedError extends Error {
	constructor() {
		super("Baileys socket is not connected");
		this.name = "RuntimeNotConnectedError";
	}
}
