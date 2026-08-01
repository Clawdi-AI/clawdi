import { isJidGroup, isLidUser, isPnUser, jidDecode, jidNormalizedUser } from "baileys";

export function normalizeApplicationUserJid(value: string): string | undefined {
	return normalizeApplicationJid(value, false);
}

export function normalizeApplicationChatJid(value: string): string | undefined {
	return normalizeApplicationJid(value, true);
}

function normalizeApplicationJid(value: string, allowGroup: boolean): string | undefined {
	const decoded = jidDecode(value);
	const normalized = jidNormalizedUser(value);
	if (!decoded?.user || normalized !== value) return undefined;
	if (isPnUser(normalized) || isLidUser(normalized)) return normalized;
	if (allowGroup && isJidGroup(normalized)) return normalized;
	return undefined;
}
