import {
	extractMessageContent,
	getContentType,
	type proto,
	type WAMessage,
	type WAMessageKey,
} from "baileys";

import {
	mediaIdForEvent,
	normalizeActorAliases,
	normalizeChatAliases,
	normalizeSupportedJid,
	providerEventId,
} from "./jid.js";
import {
	EVENT_SCHEMA_VERSION,
	type JidAliasPair,
	type MessageReference,
	type NormalizedContent,
	type NormalizedInboundMessage,
} from "./types.js";

const MAX_TEXT_LENGTH = 16_384;

export function normalizeInboundMessage(
	message: WAMessage,
	accountId: string,
	self?: JidAliasPair,
): NormalizedInboundMessage | null {
	const messageId = boundedText(message.key.id, 300);
	const remoteJid = message.key.remoteJid;
	if (!messageId || !remoteJid) return null;
	let chat: JidAliasPair;
	let actor: JidAliasPair;
	try {
		chat = normalizeChatAliases(remoteJid, message.key.remoteJidAlt ?? undefined);
		actor = actorForMessage(message.key, chat, self);
	} catch {
		return null;
	}
	const eventId = providerEventId({ accountId, messageId, chat, actor });
	const content = normalizeContent(message, eventId);
	const replyTo = quotedReference(message, chat);
	const timestamp = numericTimestamp(message.messageTimestamp);
	const pushName = boundedText(message.pushName, 200);
	return {
		schemaVersion: EVENT_SCHEMA_VERSION,
		providerEventId: eventId,
		accountId,
		eventType: "message",
		messageId,
		chat,
		actor,
		fromMe: Boolean(message.key.fromMe),
		ownership: message.key.fromMe ? "self" : "peer",
		content,
		...(replyTo ? { replyTo } : {}),
		...(pushName ? { pushName } : {}),
		...(timestamp !== undefined ? { timestamp } : {}),
	};
}

function actorForMessage(key: WAMessageKey, chat: JidAliasPair, self?: JidAliasPair): JidAliasPair {
	if (key.fromMe && self) return normalizeActorAliases(self.primary, self.alt);
	if (key.participant) {
		return normalizeActorAliases(key.participant, key.participantAlt ?? undefined);
	}
	return normalizeActorAliases(chat.primary, chat.alt);
}

function normalizeContent(message: WAMessage, eventId: string): NormalizedContent {
	const content = extractMessageContent(message.message);
	if (!content) return { type: "unknown", providerContentType: "empty" };
	if (typeof content.conversation === "string") {
		return { type: "text", text: content.conversation.slice(0, MAX_TEXT_LENGTH) };
	}
	if (content.extendedTextMessage?.text !== undefined) {
		return {
			type: "text",
			text: String(content.extendedTextMessage.text).slice(0, MAX_TEXT_LENGTH),
		};
	}
	const media = mediaContent(content);
	if (media) {
		return {
			type: "media",
			mediaId: mediaIdForEvent(eventId),
			mediaType: media.type,
			...(boundedText(media.value.mimetype, 255)
				? { mimeType: boundedText(media.value.mimetype, 255) }
				: {}),
			...(boundedText(media.value.fileName, 255)
				? { fileName: boundedText(media.value.fileName, 255) }
				: {}),
			...(numericLength(media.value.fileLength) !== undefined
				? { fileLength: numericLength(media.value.fileLength) }
				: {}),
			...(boundedText(media.value.caption, MAX_TEXT_LENGTH)
				? { caption: boundedText(media.value.caption, MAX_TEXT_LENGTH) }
				: {}),
		};
	}
	if (content.reactionMessage?.key) {
		const target = referenceFromKey(content.reactionMessage.key);
		if (target) {
			return {
				type: "reaction",
				reaction: String(content.reactionMessage.text ?? "").slice(0, 64),
				target,
			};
		}
	}
	return {
		type: "unknown",
		providerContentType: String(getContentType(content) ?? "unsupported").slice(0, 80),
	};
}

function mediaContent(content: proto.IMessage):
	| {
			type: "image" | "video" | "audio" | "document" | "sticker";
			value: {
				mimetype?: string | null;
				fileName?: string | null;
				fileLength?: number | LongLike | null;
				caption?: string | null;
			};
	  }
	| undefined {
	if (content.imageMessage) return { type: "image", value: content.imageMessage };
	if (content.videoMessage) return { type: "video", value: content.videoMessage };
	if (content.audioMessage) return { type: "audio", value: content.audioMessage };
	if (content.documentMessage) return { type: "document", value: content.documentMessage };
	if (content.stickerMessage) return { type: "sticker", value: content.stickerMessage };
	return undefined;
}

function quotedReference(message: WAMessage, chat: JidAliasPair): MessageReference | undefined {
	const content = extractMessageContent(message.message);
	if (!content) return undefined;
	const context = findContextInfo(content);
	const messageId = boundedText(context?.stanzaId, 300);
	if (!messageId) return undefined;
	const reference: MessageReference = {
		messageId,
		fromMe: false,
	};
	if (context?.remoteJid && context.remoteJid !== chat.primary) {
		const remote = normalizeSupportedJid(context.remoteJid);
		if (!remote) return undefined;
		reference.chatJid = remote.jid;
	}
	if (context?.participant) {
		const participant = normalizeSupportedJid(context.participant);
		if (!participant || participant.kind === "group") return undefined;
		reference.participantJid = participant.jid;
	}
	return reference;
}

function findContextInfo(content: proto.IMessage): proto.IContextInfo | null | undefined {
	return (
		content.extendedTextMessage?.contextInfo ??
		content.imageMessage?.contextInfo ??
		content.videoMessage?.contextInfo ??
		content.documentMessage?.contextInfo ??
		content.stickerMessage?.contextInfo ??
		content.audioMessage?.contextInfo
	);
}

function referenceFromKey(key: proto.IMessageKey): MessageReference | undefined {
	const messageId = boundedText(key.id, 300);
	if (!messageId) return undefined;
	const chat = key.remoteJid ? normalizeSupportedJid(key.remoteJid) : undefined;
	if (key.remoteJid && !chat) return undefined;
	const participant = key.participant ? normalizeSupportedJid(key.participant) : undefined;
	if (key.participant && (!participant || participant.kind === "group")) return undefined;
	return {
		messageId,
		fromMe: Boolean(key.fromMe),
		...(chat ? { chatJid: chat.jid } : {}),
		...(participant ? { participantJid: participant.jid } : {}),
	};
}

type LongLike = { toNumber?: () => number; toString: () => string };

function numericTimestamp(value: number | LongLike | null | undefined): number | undefined {
	if (value === null || value === undefined) return undefined;
	const number = typeof value === "number" ? value : Number(value.toString());
	return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function numericLength(value: number | LongLike | null | undefined): number | undefined {
	return numericTimestamp(value);
}

function boundedText(value: string | null | undefined, maximum: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text.slice(0, maximum) : undefined;
}
