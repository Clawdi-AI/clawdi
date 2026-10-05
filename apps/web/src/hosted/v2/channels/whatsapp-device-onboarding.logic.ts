export {
	whatsappOnboardingRequiresCleanup,
	whatsappOnboardingShouldPoll,
	whatsappPhoneNumberError,
} from "@clawdi/shared/api";
export { whatsappReadinessMessage } from "@clawdi/shared/view";

export function whatsappQrExpiryLabel(expiresAt: string | null | undefined, nowMs: number): string {
	if (!expiresAt) return "Waiting for a new QR code…";
	const expiresAtMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
		return "Refreshing QR code…";
	}
	const seconds = Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1_000));
	return `QR refreshes in ${seconds}s`;
}
