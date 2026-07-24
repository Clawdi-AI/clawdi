export function pairCodeRequiresExplicitAgent(linkedAgentCount: number): boolean {
	return linkedAgentCount !== 1;
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
		transport.mode === "in_process"
			? "Direct connection"
			: transport.mode === "sidecar"
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
