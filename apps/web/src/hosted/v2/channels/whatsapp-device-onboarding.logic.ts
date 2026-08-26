import type {
	WhatsAppOnboardingReadiness,
	WhatsAppOnboardingState,
} from "@/hosted/v2/channels/channel-types";

const E164_DIGITS = /^[1-9][0-9]{6,14}$/;

export function whatsappPhoneNumberError(value: string): string | null {
	if (!value) return null;
	return E164_DIGITS.test(value)
		? null
		: "Use country code and digits only, without +, spaces, or punctuation.";
}

export function whatsappOnboardingShouldPoll(state: WhatsAppOnboardingState): boolean {
	return state === "generating" || state === "ready" || state === "scanned";
}

export function whatsappOnboardingRequiresCleanup(state: WhatsAppOnboardingState): boolean {
	return whatsappOnboardingShouldPoll(state) || state === "error";
}

export function whatsappQrExpiryLabel(expiresAt: string | null | undefined, nowMs: number): string {
	if (!expiresAt) return "Waiting for a new QR code…";
	const expiresAtMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
		return "Refreshing QR code…";
	}
	const seconds = Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1_000));
	return `QR refreshes in ${seconds}s`;
}

export function whatsappReadinessMessage(
	readiness: WhatsAppOnboardingReadiness | undefined,
	isError: boolean,
): string {
	if (isError) return "Your WhatsApp connection is temporarily unavailable.";
	if (!readiness) return "Checking linked-device availability…";
	if (readiness.available) return "Ready to connect as a linked device.";
	switch (readiness.reason) {
		case "no_capacity":
			return "All linked-device slots are currently in use.";
		case "managed_sidecar_required":
			return "This Agent doesn't support linked WhatsApp devices.";
		case "temporarily_unavailable":
			return "Linked-device support is temporarily unavailable.";
		default:
			return "Linked WhatsApp devices aren't available for this Agent.";
	}
}
