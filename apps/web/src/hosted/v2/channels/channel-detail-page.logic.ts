export { telegramPairDeepLink } from "@clawdi/shared/api";

export function pairCodeExpiryLabel(expiresAt: string, nowMs: number): string {
	const expiresAtMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresAtMs)) return "Expired — generate a new link";
	const remainingSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
	if (remainingSeconds <= 0) return "Expired — generate a new link";
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	return `Expires in ${minutes > 0 ? `${minutes}m ` : ""}${seconds}s`;
}

export type NativeTransportSummary = {
	status: string;
	connection: string;
	delivery: string;
};

export function nativeTransportSummary(transport: Record<string, unknown>): NativeTransportSummary {
	const status =
		transport.available === true
			? "Ready"
			: transport.available === false
				? "Unavailable"
				: "Unknown";
	const connection =
		transport.mode === "sidecar"
			? "Managed connection"
			: transport.mode === "none"
				? "Not connected"
				: "Details unavailable";
	const delivery =
		transport.supportsOutboundMessages === true
			? "Available"
			: transport.supportsOutboundMessages === false
				? "Unavailable"
				: "Unknown";

	return { status, connection, delivery };
}
