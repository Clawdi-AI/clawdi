import type { components } from "../api/api.generated";

export const whatsappOnboardingCopy = {
	accountDescription: "Add a WhatsApp account you own by scanning a linked-device QR.",
	warningTitle: "Use a dedicated number",
	warningDescription:
		"Clawdi connects as a WhatsApp linked device, and agent replies come from this account. Use a separate number, not your personal one.",
	connectAccount: "Connect your account",
	checking: "Checking linked-device availability…",
	accountNextSteps:
		"This adds the account under custom bots. Agent link and chat pair are separate next steps.",
	accountName: "Account name",
	accountPlaceholder: "Personal WhatsApp",
	nameHint: "This names the custom bot inventory entry. It does not rename your WhatsApp account.",
	generateQr: "Generate QR",
	generating: "Generating QR code…",
	scanned: "Device approved",
	connected: "WhatsApp connected",
	expired: "Connection expired",
	canceled: "Connection canceled",
	error: "Couldn't connect WhatsApp",
	scanInstruction: "WhatsApp > Settings/Menu > Linked devices > Link a device > scan.",
	phoneWarning:
		"A phone cannot scan a QR shown on the same phone. Open Clawdi on a computer, or use the pairing-code fallback below.",
	fallback: "Can't scan? Use a pairing code",
	requestCode: "Get pairing code",
} as const;

export function whatsappReadinessMessage(
	readiness: components["schemas"]["ChannelWhatsAppOnboardingReadinessResponse"] | undefined,
	isError: boolean,
): string {
	if (isError) return "Your WhatsApp connection is temporarily unavailable.";
	if (!readiness) return whatsappOnboardingCopy.checking;
	if (readiness.available) return "Ready to connect as a linked device.";
	switch (readiness.reason) {
		case "no_capacity":
			return "All linked-device slots are currently in use.";
		case "managed_sidecar_required":
			return "Linked WhatsApp devices are not supported by this agent.";
		case "temporarily_unavailable":
			return "Linked-device pairing is temporarily unavailable.";
		default:
			return "Linked-device pairing is not available for this agent.";
	}
}
