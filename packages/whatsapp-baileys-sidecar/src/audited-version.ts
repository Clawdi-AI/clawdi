import type { WAVersion } from "baileys";

export const AUDITED_BAILEYS_RELEASE = "7.0.0-rc13";
export const AUDITED_BAILEYS_PACKAGE = "@whiskeysockets/baileys";
export const AUDITED_BAILEYS_SOURCE_COMMIT = "8053b086ecc97ec3f78299561de11959bab05d39";
export const AUDITED_WHATSAPP_WEB_VERSION_TEXT = "2.3000.1035194821";
export const AUDITED_WHATSAPP_WEB_VERSION = [2, 3000, 1_035_194_821] as const satisfies WAVersion;

export const AUDITED_PROVIDER_RELEASE = {
	packageName: AUDITED_BAILEYS_PACKAGE,
	packageVersion: AUDITED_BAILEYS_RELEASE,
	sourceCommit: AUDITED_BAILEYS_SOURCE_COMMIT,
	version: AUDITED_WHATSAPP_WEB_VERSION,
} as const;

/**
 * Keep the provider socket on the Web version audited with the pinned Baileys
 * release. Changing it requires an explicit source/doc/test update and an
 * explicit migration of existing provider state metadata.
 */
export function parseAuditedWhatsAppWebVersion(raw: string): WAVersion {
	const candidate = raw.trim();
	if (!/^\d+\.\d+\.\d+$/.test(candidate)) {
		throw new Error("CLAWDI_WA_WEB_VERSION must contain three dot-separated integers");
	}
	const parts = candidate.split(".").map((part) => Number(part));
	if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
		throw new Error("CLAWDI_WA_WEB_VERSION contains an invalid version component");
	}
	if (candidate !== AUDITED_WHATSAPP_WEB_VERSION_TEXT) {
		throw new Error(`CLAWDI_WA_WEB_VERSION is not audited for Baileys ${AUDITED_BAILEYS_RELEASE}`);
	}
	return [parts[0], parts[1], parts[2]];
}
