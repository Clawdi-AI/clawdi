import { extractMessageContent, isJidGroup, type proto, type WAMessage } from "baileys";

import { normalizeApplicationChatJid, normalizeApplicationUserJid } from "./application-jid.js";
import type { NormalizedInboundMessage } from "./types.js";

export function normalizeInboundMessage(
	message: WAMessage,
	metadata: { upsertType: string; requestId?: string },
): NormalizedInboundMessage | null {
	if (metadata.upsertType !== "notify") return null;
	const messageId = nonEmpty(message.key.id);
	const rawChatJid = nonEmpty(message.key.remoteJid);
	const chatJid = rawChatJid ? normalizeApplicationChatJid(rawChatJid) : undefined;
	if (!messageId || !chatJid || message.key.fromMe === true || !message.message) {
		return null;
	}
	const isGroup = Boolean(isJidGroup(chatJid));
	const rawParticipantJid = nonEmpty(message.key.participant);
	const participantJid = rawParticipantJid
		? normalizeApplicationUserJid(rawParticipantJid)
		: undefined;
	if (isGroup && !participantJid) return null;
	const actorJid = isGroup ? participantJid : chatJid;
	if (!actorJid) {
		return null;
	}
	const content = extractMessageContent(message.message);
	const text = messageText(content);
	if (!text) return null;
	const timestamp = numericTimestamp(message.messageTimestamp);
	const rawChatJidAlt = nonEmpty(message.key.remoteJidAlt);
	const chatJidAlt = rawChatJidAlt ? normalizeApplicationUserJid(rawChatJidAlt) : undefined;
	const rawActorJidAlt = nonEmpty(message.key.participantAlt);
	const actorJidAlt = rawActorJidAlt ? normalizeApplicationUserJid(rawActorJidAlt) : undefined;
	return {
		schemaVersion: "clawdi.whatsapp.sidecar-event.v1",
		providerEventId: `message:${messageId}`,
		messageId,
		chatJid,
		...(chatJidAlt ? { chatJidAlt } : {}),
		actorJid,
		...(actorJidAlt ? { actorJidAlt } : {}),
		fromMe: false,
		text,
		...(nonEmpty(message.pushName) ? { pushName: nonEmpty(message.pushName) } : {}),
		...(timestamp === undefined ? {} : { timestamp }),
	};
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
