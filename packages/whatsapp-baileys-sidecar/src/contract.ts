import { createHash } from "node:crypto";

import { normalizeActorAliases, normalizeChatAliases, normalizeSupportedJid } from "./jid.js";
import { type MessageReference, OPERATION_SCHEMA_VERSION, type SidecarOperation } from "./types.js";

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

export class ContractValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContractValidationError";
	}
}

export function parseOperation(value: unknown): SidecarOperation {
	const body = record(value, "body");
	if (body.schemaVersion !== OPERATION_SCHEMA_VERSION) fail("unsupported_schema_version");
	const operationId = identifier(body.operationId, "operationId", 200);
	const chat = normalizeChat(requiredString(body.chatJid, "chatJid", 100));
	const type = requiredString(body.type, "type", 20);
	const base = {
		schemaVersion: OPERATION_SCHEMA_VERSION,
		operationId,
		chatJid: chat,
	};
	if (type === "send") {
		assertKeys(
			body,
			["schemaVersion", "operationId", "chatJid", "type", "messageId", "content", "replyTo"],
			"body",
		);
		const messageId = identifier(body.messageId, "messageId", 200);
		const content = record(body.content, "content");
		const contentType = requiredString(content.type, "content.type", 20);
		const replyTo =
			body.replyTo === undefined ? undefined : parseMessageReference(body.replyTo, chat, "replyTo");
		if (contentType === "text") {
			assertKeys(content, ["type", "text"], "content");
			return {
				...base,
				type,
				messageId,
				content: { type: "text", text: contentText(content.text, "content.text", 4096) },
				...(replyTo ? { replyTo } : {}),
			};
		}
		if (contentType !== "media") fail("unsupported_send_content");
		assertKeys(
			content,
			["type", "mediaType", "dataBase64", "mimeType", "fileName", "caption"],
			"content",
		);
		const mediaType = requiredString(content.mediaType, "content.mediaType", 20);
		if (!new Set(["image", "video", "audio", "document"]).has(mediaType)) {
			fail("unsupported_media_type");
		}
		const dataBase64 = requiredString(
			content.dataBase64,
			"content.dataBase64",
			Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 4,
		);
		if (
			!isCanonicalBase64(dataBase64) ||
			Buffer.byteLength(dataBase64, "base64") > MAX_MEDIA_BYTES
		) {
			fail("content_media_invalid_or_too_large");
		}
		const mimeType = requiredString(content.mimeType, "content.mimeType", 255);
		if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) {
			fail("content_mimeType_invalid");
		}
		const fileName = optionalString(content.fileName, "content.fileName", 255);
		const caption = optionalContentText(content.caption, "content.caption", 4096);
		return {
			...base,
			type,
			messageId,
			content: {
				type: "media",
				mediaType: mediaType as "image" | "video" | "audio" | "document",
				dataBase64,
				mimeType,
				...(fileName ? { fileName } : {}),
				...(caption ? { caption } : {}),
			},
			...(replyTo ? { replyTo } : {}),
		};
	}
	if (type === "edit") {
		assertKeys(
			body,
			["schemaVersion", "operationId", "chatJid", "type", "messageId", "target", "text"],
			"body",
		);
		const target = parseMessageReference(body.target, chat, "target");
		if (!target.fromMe) fail("edit_target_must_be_owned");
		return {
			...base,
			type,
			messageId: identifier(body.messageId, "messageId", 200),
			target,
			text: contentText(body.text, "text", 4096),
		};
	}
	if (type === "delete") {
		assertKeys(
			body,
			["schemaVersion", "operationId", "chatJid", "type", "messageId", "target"],
			"body",
		);
		const target = parseMessageReference(body.target, chat, "target");
		if (!target.fromMe) fail("delete_target_must_be_owned");
		return {
			...base,
			type,
			messageId: identifier(body.messageId, "messageId", 200),
			target,
		};
	}
	if (type === "reaction") {
		assertKeys(
			body,
			["schemaVersion", "operationId", "chatJid", "type", "messageId", "target", "reaction"],
			"body",
		);
		const reaction = stringValue(body.reaction, "reaction", 64).trim();
		return {
			...base,
			type,
			messageId: identifier(body.messageId, "messageId", 200),
			target: parseMessageReference(body.target, chat, "target"),
			reaction,
		};
	}
	if (type === "presence") {
		assertKeys(body, ["schemaVersion", "operationId", "chatJid", "type", "presence"], "body");
		const presence = requiredString(body.presence, "presence", 20);
		if (!new Set(["composing", "recording", "paused"]).has(presence)) {
			fail("unsupported_presence");
		}
		return {
			...base,
			type,
			presence: presence as "composing" | "recording" | "paused",
		};
	}
	if (type === "read") {
		assertKeys(body, ["schemaVersion", "operationId", "chatJid", "type", "messages"], "body");
		if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 100) {
			fail("messages_must_contain_1_to_100_refs");
		}
		return {
			...base,
			type,
			messages: body.messages.map((item, index) =>
				parseMessageReference(item, chat, `messages[${index}]`),
			),
		};
	}
	fail("unsupported_operation_type");
}

export function canonicalRequestHash(value: SidecarOperation): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseMessageReference(
	value: unknown,
	defaultChat: string,
	path: string,
): MessageReference {
	const body = record(value, path);
	assertKeys(
		body,
		["messageId", "chatJid", "chatJidAlt", "participantJid", "participantJidAlt", "fromMe"],
		path,
	);
	const messageId = identifier(body.messageId, `${path}.messageId`, 200);
	if (typeof body.fromMe !== "boolean") fail(`${path}.fromMe_must_be_boolean`);
	const defaultNormalized = normalizeSupportedJid(defaultChat);
	if (!defaultNormalized) fail(`${path}.default_chat_unsupported`);
	const rawChat = optionalString(body.chatJid, `${path}.chatJid`, 100);
	const rawChatAlt = optionalString(body.chatJidAlt, `${path}.chatJidAlt`, 100);
	if (!rawChat && rawChatAlt) fail(`${path}.chatJid_required_with_alt`);
	let chatJid: string | undefined;
	let chatJidAlt: string | undefined;
	if (rawChat) {
		const pair = normalizeChatPair(rawChat, rawChatAlt, path);
		if (!new Set([pair.primary, pair.alt]).has(defaultNormalized.jid)) {
			fail(`${path}.chat_conflicts_with_operation_chat`);
		}
		chatJid = pair.primary;
		chatJidAlt = pair.alt;
	}
	const rawParticipant = optionalString(body.participantJid, `${path}.participantJid`, 100);
	const rawParticipantAlt = optionalString(
		body.participantJidAlt,
		`${path}.participantJidAlt`,
		100,
	);
	if (!rawParticipant && rawParticipantAlt) fail(`${path}.participantJid_required_with_alt`);
	let participantJid: string | undefined;
	let participantJidAlt: string | undefined;
	if (rawParticipant) {
		try {
			const pair = normalizeActorAliases(rawParticipant, rawParticipantAlt);
			participantJid = pair.primary;
			participantJidAlt = pair.alt;
		} catch (error: unknown) {
			fail(error instanceof Error ? error.message : `${path}.participant_invalid`);
		}
	}
	const effectiveChat = normalizeSupportedJid(chatJid ?? defaultNormalized.jid);
	if (effectiveChat?.kind === "group" && body.fromMe === false && participantJid === undefined) {
		fail(`${path}.participant_required_for_group_peer`);
	}
	return {
		messageId,
		fromMe: body.fromMe,
		...(chatJid ? { chatJid } : {}),
		...(chatJidAlt ? { chatJidAlt } : {}),
		...(participantJid ? { participantJid } : {}),
		...(participantJidAlt ? { participantJidAlt } : {}),
	};
}

function normalizeChat(value: string): string {
	try {
		return normalizeChatAliases(value).primary;
	} catch (error: unknown) {
		fail(error instanceof Error ? error.message : "unsupported_chat_jid");
	}
}

function normalizeChatPair(primary: string, alt: string | undefined, path: string) {
	try {
		return normalizeChatAliases(primary, alt);
	} catch (error: unknown) {
		fail(error instanceof Error ? error.message : `${path}.chat_invalid`);
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function identifier(value: unknown, name: string, maximum: number): string {
	const text = requiredString(value, name, maximum);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) fail(`${name}_invalid`);
	return text;
}

function contentText(value: unknown, name: string, maximum: number): string {
	const text = stringValue(value, name, maximum);
	if (!text.trim()) fail(`${name}_required`);
	return text;
}

function optionalContentText(value: unknown, name: string, maximum: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	return contentText(value, name, maximum);
}

function requiredString(value: unknown, name: string, maximum: number): string {
	const text = stringValue(value, name, maximum).trim();
	if (!text) fail(`${name}_required`);
	return text;
}

function optionalString(value: unknown, name: string, maximum: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = stringValue(value, name, maximum).trim();
	return text || undefined;
}

function stringValue(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string") fail(`${name}_must_be_string`);
	if (value.length > maximum) fail(`${name}_too_long`);
	return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!isRecord(value)) fail(`${name}_must_be_object`);
	return value;
}

function isCanonicalBase64(value: string): boolean {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		return false;
	}
	return Buffer.from(value, "base64").toString("base64") === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
): void {
	const allowedKeys = new Set(allowed);
	const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unexpected) fail(`${path}.${unexpected}_unsupported`);
}

function fail(message: string): never {
	throw new ContractValidationError(message);
}
