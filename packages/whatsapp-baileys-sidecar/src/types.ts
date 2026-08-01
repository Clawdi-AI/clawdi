export const OPERATION_SCHEMA_VERSION = "clawdi.whatsapp.operation.v1" as const;
export const EVENT_SCHEMA_VERSION = "clawdi.whatsapp.sidecar-event.v1" as const;

export type RuntimeStatus =
	| "starting"
	| "pairing_qr"
	| "pairing_code"
	| "connected"
	| "disconnected"
	| "fatal"
	| "stopped";

export type AdvertisedRelease = {
	packageName: string;
	packageVersion: string;
	sourceCommit: string;
	version: readonly [number, number, number];
};

export type RuntimeHealth = {
	status: RuntimeStatus;
	connected: boolean;
	uptimeSeconds: number;
	accountId: string;
	advertisedRelease: AdvertisedRelease;
	versionRecoveryRequired: boolean;
	registered: boolean;
	callback: {
		enabled: boolean;
		pendingEvents: number;
	};
	lastDisconnectReason?: string;
	fatalReason?: string;
};

export type RuntimeCapabilities = {
	schemaVersion: "clawdi.whatsapp.sidecar-capabilities.v1";
	operations: readonly ["send", "edit", "delete", "reaction", "presence", "read"];
	pairing: readonly ["qr", "code", "cancel", "logout", "recover"];
	mediaDownload: true;
	callbackDelivery: boolean;
	jidKinds: readonly ["pn", "lid", "group"];
	rawProviderAccess: false;
};

export type JidAliasPair = {
	primary: string;
	alt?: string;
};

export type MessageReference = {
	messageId: string;
	chatJid?: string;
	chatJidAlt?: string;
	participantJid?: string;
	participantJidAlt?: string;
	fromMe: boolean;
};

type OperationBase = {
	schemaVersion: typeof OPERATION_SCHEMA_VERSION;
	operationId: string;
	chatJid: string;
};

export type SendOperation = OperationBase & {
	type: "send";
	messageId: string;
	content:
		| { type: "text"; text: string }
		| {
				type: "media";
				mediaType: "image" | "video" | "audio" | "document";
				dataBase64: string;
				mimeType: string;
				ptt?: boolean;
				fileName?: string;
				caption?: string;
		  };
	replyTo?: MessageReference;
};

export type EditOperation = OperationBase & {
	type: "edit";
	messageId: string;
	target: MessageReference;
	text: string;
};

export type DeleteOperation = OperationBase & {
	type: "delete";
	messageId: string;
	target: MessageReference;
};

export type ReactionOperation = OperationBase & {
	type: "reaction";
	messageId: string;
	target: MessageReference;
	reaction: string;
};

export type PresenceOperation = OperationBase & {
	type: "presence";
	presence: "composing" | "recording" | "paused";
};

export type ReadOperation = OperationBase & {
	type: "read";
	messages: MessageReference[];
};

export type SidecarOperation =
	| SendOperation
	| EditOperation
	| DeleteOperation
	| ReactionOperation
	| PresenceOperation
	| ReadOperation;

export type OperationStatus = "pending" | "completed" | "failed" | "ambiguous";

export type OperationResult = {
	operationId: string;
	status: Exclude<OperationStatus, "pending">;
	messageId?: string;
	error?: string;
};

export type NormalizedContent =
	| { type: "text"; text: string }
	| {
			type: "media";
			mediaId: string;
			mediaType: "image" | "video" | "audio" | "document" | "sticker";
			mimeType?: string;
			ptt?: boolean;
			fileName?: string;
			fileLength?: number;
			caption?: string;
	  }
	| { type: "reaction"; reaction: string; target: MessageReference }
	| { type: "unknown"; providerContentType: string };

export type NormalizedInboundMessage = {
	schemaVersion: typeof EVENT_SCHEMA_VERSION;
	providerEventId: string;
	accountId: string;
	eventType: "message";
	messageId: string;
	chat: JidAliasPair;
	actor: JidAliasPair;
	fromMe: boolean;
	ownership: "self" | "peer";
	content: NormalizedContent;
	replyTo?: MessageReference;
	pushName?: string;
	timestamp?: number;
};

export type PairingStatus = {
	status: RuntimeStatus;
	registered: boolean;
	method?: "qr" | "code";
	qr?: string;
	code?: string;
};

export type MediaDownload = {
	data: Buffer;
	contentType: string;
	fileName?: string;
};

export type BaileysRuntime = {
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): RuntimeHealth;
	capabilities(): RuntimeCapabilities;
	pairingStatus(): PairingStatus;
	startQrPairing(): Promise<PairingStatus>;
	startCodePairing(phoneNumber: string): Promise<PairingStatus>;
	cancelPairing(): Promise<PairingStatus>;
	logout(): Promise<PairingStatus>;
	recover(acceptVersionChange: boolean, resetLoggedOut?: boolean): Promise<void>;
	performOperation(operation: SidecarOperation, requestHash: string): Promise<OperationResult>;
	downloadMedia(mediaId: string): Promise<MediaDownload>;
};

export class RuntimeNotConnectedError extends Error {
	constructor() {
		super("Baileys socket is not connected");
		this.name = "RuntimeNotConnectedError";
	}
}

export class RuntimeFatalError extends Error {
	constructor(message = "Baileys runtime is in a fail-stop state") {
		super(message);
		this.name = "RuntimeFatalError";
	}
}

export class OperationConflictError extends Error {
	constructor() {
		super("operationId was already used with a different request");
		this.name = "OperationConflictError";
	}
}

export class MessageNotFoundError extends Error {
	constructor(message = "referenced WhatsApp message was not found") {
		super(message);
		this.name = "MessageNotFoundError";
	}
}

export class MediaNotFoundError extends Error {
	constructor() {
		super("media was not found");
		this.name = "MediaNotFoundError";
	}
}

export class MediaTooLargeError extends Error {
	constructor() {
		super("downloaded media exceeds the configured byte limit");
		this.name = "MediaTooLargeError";
	}
}

export class VersionRecoveryRequiredError extends Error {
	constructor() {
		super(
			"persisted Baileys release differs from this sidecar release; explicit recovery acceptance is required",
		);
		this.name = "VersionRecoveryRequiredError";
	}
}

export class LoggedOutResetRequiredError extends Error {
	constructor() {
		super("logged-out auth requires an explicit reset before pairing again");
		this.name = "LoggedOutResetRequiredError";
	}
}

export class LoggedOutResetNotAllowedError extends Error {
	constructor(message = "logged-out auth reset is not allowed in the current runtime state") {
		super(message);
		this.name = "LoggedOutResetNotAllowedError";
	}
}

export class AccountResetBlockedError extends Error {
	constructor() {
		super("account auth cannot reset while callback events are pending");
		this.name = "AccountResetBlockedError";
	}
}
