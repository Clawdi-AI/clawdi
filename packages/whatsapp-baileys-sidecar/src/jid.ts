import { isJidGroup, isLidUser, isPnUser, jidDecode, jidNormalizedUser } from "baileys";

export function normalizeUserJid(value: string): string | undefined {
	return normalizeJid(value, false);
}

export function normalizeChatJid(value: string): string | undefined {
	return normalizeJid(value, true);
}

function normalizeJid(value: string, allowGroup: boolean): string | undefined {
	const decoded = jidDecode(value);
	const normalized = jidNormalizedUser(value);
	if (!decoded?.user || normalized !== value) return undefined;
	if (isPnUser(normalized) || isLidUser(normalized)) return normalized;
	if (allowGroup && isJidGroup(normalized)) return normalized;
	return undefined;
}
