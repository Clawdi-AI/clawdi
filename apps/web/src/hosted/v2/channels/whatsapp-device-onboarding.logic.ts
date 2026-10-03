import type { WhatsAppOnboardingReadiness } from "@/hosted/v2/channels/channel-types";

export {
	whatsappOnboardingRequiresCleanup,
	whatsappOnboardingShouldPoll,
	whatsappPhoneNumberError,
} from "@clawdi/shared/api";

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
			return "Linked WhatsApp devices are not supported by this Agent.";
		case "temporarily_unavailable":
			return "Linked-device pairing is temporarily unavailable.";
		default:
			return "Linked-device pairing is not available for this Agent.";
	}
}
