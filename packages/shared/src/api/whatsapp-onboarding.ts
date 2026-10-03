import type { components } from "./api.generated";

export type WhatsAppSession = components["schemas"]["ChannelWhatsAppOnboardingSessionResponse"];
export function whatsappPhoneNumberError(value: string): string | null {
	if (!value) return null;
	return /^[1-9][0-9]{6,14}$/.test(value)
		? null
		: "Use country code and digits only, without +, spaces, or punctuation.";
}
export function whatsappOnboardingShouldPoll(state: WhatsAppSession["state"]): boolean {
	return state === "generating" || state === "ready" || state === "scanned";
}
export function whatsappOnboardingRequiresCleanup(state: WhatsAppSession["state"]): boolean {
	return whatsappOnboardingShouldPoll(state) || state === "error";
}
/** Retain recovery identity across backgrounding, never authentication material. */
export function redactWhatsAppSession(session: WhatsAppSession): WhatsAppSession {
	return { ...session, qr: null, qr_expires_at: null, pairing_code: null };
}
