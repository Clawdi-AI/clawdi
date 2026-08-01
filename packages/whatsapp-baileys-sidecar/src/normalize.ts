import { createHash } from "node:crypto";

import { extractMessageContent, isJidGroup, type proto, type WAMessage } from "baileys";

import { normalizeChatJid, normalizeUserJid } from "./jid.js";
import type { NormalizedInboundMessage } from "./types.js";

export function normalizeInboundMessage(
	message: WAMessage,
	metadata: { upsertType: string; requestId?: string },
): NormalizedInboundMessage | null {
	if (metadata.upsertType !== "notify") return null;
	const messageId = boundedNonEmpty(message.key.id, 300);
	const rawChatJid = boundedNonEmpty(message.key.remoteJid, 300);
	const chatJid = rawChatJid ? normalizeChatJid(rawChatJid) : undefined;
	if (!messageId || !chatJid || message.key.fromMe === true || !message.message) {
		return null;
	}
	const isGroup = Boolean(isJidGroup(chatJid));
	const rawParticipantJid = nonEmpty(message.key.participant);
	const participantJid = rawParticipantJid ? normalizeUserJid(rawParticipantJid) : undefined;
	if (isGroup && !participantJid) return null;
	const actorJid = isGroup ? participantJid : chatJid;
	if (!actorJid) {
		return null;
	}
	const content = extractMessageContent(message.message);
	const text = messageText(content);
	if (!text || text.length > 4096) return null;
	const timestamp = numericTimestamp(message.messageTimestamp);
	const rawChatJidAlt = nonEmpty(message.key.remoteJidAlt);
	const chatJidAlt = rawChatJidAlt ? normalizeUserJid(rawChatJidAlt) : undefined;
	const rawActorJidAlt = nonEmpty(message.key.participantAlt);
	const actorJidAlt = rawActorJidAlt ? normalizeUserJid(rawActorJidAlt) : undefined;
	const pushName = boundedNonEmpty(message.pushName, 300);
	return {
		schemaVersion: "clawdi.whatsapp.sidecar-event.v1",
		providerEventId: providerEventId(chatJid, messageId, participantJid),
		messageId,
		chatJid,
		...(chatJidAlt ? { chatJidAlt } : {}),
		actorJid,
		...(actorJidAlt ? { actorJidAlt } : {}),
		fromMe: false,
		text,
		...(pushName ? { pushName } : {}),
		...(timestamp === undefined ? {} : { timestamp }),
	};
}

function providerEventId(chatJid: string, messageId: string, participantJid?: string): string {
	const identity = JSON.stringify([chatJid, messageId, false, participantJid ?? ""]);
	return `message:${createHash("sha256").update(identity).digest("hex")}`;
}

function messageText(message: proto.IMessage | undefined): string | undefined {
	if (!message) return undefined;
	for (const value of [
		message.conversation,
		message.extendedTextMessage?.text,
		message.imageMessage?.caption,
		message.videoMessage?.caption,
		message.documentMessage?.caption,
		message.buttonsResponseMessage?.selectedDisplayText,
		message.listResponseMessage?.title,
		message.templateButtonReplyMessage?.selectedDisplayText,
	]) {
		const text = contentText(value);
		if (text) return text;
	}
	return undefined;
}

function contentText(value: string | null | undefined): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value;
}

function numericTimestamp(value: WAMessage["messageTimestamp"]): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
		return value;
	}
	if (value === null || value === undefined) return undefined;
	const parsed = Number.parseInt(String(value), 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function nonEmpty(value: string | null | undefined): string | undefined {
	const text = value?.trim();
	return text || undefined;
}

function boundedNonEmpty(value: string | null | undefined, maxLength: number): string | undefined {
	const text = nonEmpty(value);
	return text && text.length <= maxLength ? text : undefined;
}
