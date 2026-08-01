import { createHash } from "node:crypto";

import type { JidAliasPair } from "./types.js";

export type JidKind = "pn" | "lid" | "group";

const USER_PATTERN = /^([1-9][0-9]{0,19})@(s\.whatsapp\.net|lid)$/;
const GROUP_PATTERN = /^([0-9]{5,30}(?:-[0-9]{1,30})?)@g\.us$/;

export function normalizeSupportedJid(value: string): { jid: string; kind: JidKind } | null {
	const jid = value.trim().toLowerCase();
	const user = USER_PATTERN.exec(jid);
	if (user) {
		return { jid: `${user[1]}@${user[2]}`, kind: user[2] === "lid" ? "lid" : "pn" };
	}
	if (GROUP_PATTERN.test(jid)) return { jid, kind: "group" };
	return null;
}

export function normalizeChatAliases(primary: string, alt?: string): JidAliasPair {
	const normalizedPrimary = requireSupported(primary, "chatJid");
	const normalizedAlt = alt === undefined ? undefined : requireSupported(alt, "chatJidAlt");
	if (normalizedPrimary.kind === "group") {
		if (normalizedAlt) throw new Error("group_chat_alt_not_allowed");
		return { primary: normalizedPrimary.jid };
	}
	if (normalizedAlt?.kind === "group") throw new Error("user_chat_alt_must_be_user_jid");
	validateUserAliasPair(normalizedPrimary, normalizedAlt, "chat");
	return {
		primary: normalizedPrimary.jid,
		...(normalizedAlt ? { alt: normalizedAlt.jid } : {}),
	};
}

export function normalizeActorAliases(primary: string, alt?: string): JidAliasPair {
	const normalizedPrimary = requireSupported(primary, "actorJid");
	const normalizedAlt = alt === undefined ? undefined : requireSupported(alt, "actorJidAlt");
	if (normalizedPrimary.kind === "group" || normalizedAlt?.kind === "group") {
		throw new Error("actor_must_be_user_jid");
	}
	validateUserAliasPair(normalizedPrimary, normalizedAlt, "actor");
	return {
		primary: normalizedPrimary.jid,
		...(normalizedAlt ? { alt: normalizedAlt.jid } : {}),
	};
}

export function aliasSet(pair: JidAliasPair): string[] {
	return [...new Set([pair.primary, pair.alt].filter((jid): jid is string => Boolean(jid)))].sort();
}

export function providerEventId(input: {
	accountId: string;
	messageId: string;
	chat: JidAliasPair;
	actor: JidAliasPair;
}): string {
	const identity = JSON.stringify({
		accountId: input.accountId,
		chatAliases: aliasSet(input.chat),
		actorAliases: aliasSet(input.actor),
		messageId: input.messageId,
	});
	return `message:${createHash("sha256").update(identity).digest("hex")}`;
}

export function mediaIdForEvent(eventId: string): string {
	return `media_${createHash("sha256").update(`media:${eventId}`).digest("base64url")}`;
}

export function isE164Digits(value: string): boolean {
	return /^[1-9][0-9]{6,14}$/.test(value);
}

function requireSupported(value: string, field: string): { jid: string; kind: JidKind } {
	const normalized = normalizeSupportedJid(value);
	if (!normalized) throw new Error(`${field}_unsupported`);
	return normalized;
}

function validateUserAliasPair(
	primary: { jid: string; kind: JidKind },
	alt: { jid: string; kind: JidKind } | undefined,
	field: string,
): void {
	if (!alt) return;
	if (primary.jid === alt.jid) throw new Error(`${field}_alt_duplicates_primary`);
	if (primary.kind === alt.kind) throw new Error(`${field}_aliases_must_be_pn_and_lid`);
}
