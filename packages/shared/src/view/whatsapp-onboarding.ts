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
	qrLabel: "WhatsApp linked-device QR code",
	requestCode: "Get pairing code",
	requesting: "Requesting…",
	starting: "Starting…",
	startFailedTitle: "Couldn't start WhatsApp connection",
	startFailed: "Try again. No account was added.",
	repairFailedTitle: "Couldn't start WhatsApp repair",
	repairFailed:
		"The connection status may be temporarily unavailable. Your account and history were not removed.",
	actionFailedTitle: "WhatsApp action couldn't be completed",
	actionFailed: "Try again. Sensitive pairing details were not included in this error.",
	statusCheckFailed: "Connection status is temporarily unavailable. Clawdi is still checking.",
	scannedDescription: "Finishing the encrypted WhatsApp connection. Keep this dialog open.",
	connectedDescription:
		"The account now appears under custom bots. Link it to an agent, then pair an authorized chat.",
	reconnectedDescription:
		"WhatsApp reconnected. Existing custom bot settings, agent links, paired chats, and history remain unchanged.",
	expiredDescription: "The device session was stopped. Retry to generate a fresh QR code.",
	errorDescription: "Clawdi couldn't confirm a safe connection. Retry, or go back to clean it up.",
	refreshingQr: "Refreshing QR code…",
	qrHeading: "On the WhatsApp account you want to link:",
	codeTitle: "Enter this code in your WhatsApp account",
	codeSteps:
		"WhatsApp > Settings/Menu > Linked devices > Link a device > Link with phone number instead.",
	codeHint:
		"This links the WhatsApp account for the phone number you entered. Keep this page open until Clawdi confirms the connection.",
	phoneHint:
		"Enter the phone number for the WhatsApp account you are linking, including country code, using digits only.",
	phoneLabel: "WhatsApp phone number",
	phonePlaceholder: "14155550123",
	retry: "Retry",
	done: "Done",
	reviewBots: "Review custom bots",
	cancelConnection: "Cancel connection",
	canceling: "Canceling…",
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
