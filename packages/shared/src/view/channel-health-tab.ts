import type { components } from "../api/api.generated";
import { relativeTime } from "./utils";

type Health = components["schemas"]["ChannelHealthItemResponse"];

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

export const CHANNEL_HEALTH_COPY = {
	unavailable: "Health unavailable",
	unavailableDescription: "Channel health data isn't available yet.",
	lastError: "Last error",
	transport: "Message transport",
	connection: "Connection",
	delivery: "Message delivery",
};
export function channelHealthStats(health: Health) {
	return [
		{ label: "Pending inbound", value: health.pending_inbox },
		{ label: "Pending outbound", value: health.pending_deliveries },
		{ label: "In progress", value: health.in_progress_deliveries },
		{ label: "Failed", value: health.failed_deliveries },
	];
}
export function channelHealthTone(status: string): "success" | "warning" | "destructive" {
	return status === "ok" ? "success" : status === "error" ? "destructive" : "warning";
}
export function channelHealthReportedAt(value: string | null | undefined) {
	return `Reported ${relativeTime(value)}`;
}
