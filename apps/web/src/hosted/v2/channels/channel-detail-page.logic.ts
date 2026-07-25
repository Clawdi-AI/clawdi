export function pairCodeRequiresExplicitAgent(linkedAgentCount: number): boolean {
	return linkedAgentCount !== 1;
}

export type RotatedTokenDisplayState =
	| { status: "available"; token: string; acknowledged: boolean }
	| { status: "unrecoverable" };

export function rotatedTokenDisplayState(
	token: string | null | undefined,
): RotatedTokenDisplayState {
	return token?.trim()
		? { status: "available", token, acknowledged: false }
		: { status: "unrecoverable" };
}

export function acknowledgeRotatedToken(state: RotatedTokenDisplayState): RotatedTokenDisplayState {
	return state.status === "available" ? { ...state, acknowledged: true } : state;
}

export function hasAtRiskRotatedToken(
	states: Readonly<Record<string, RotatedTokenDisplayState>>,
	rotationPending: boolean,
): boolean {
	return (
		rotationPending ||
		Object.values(states).some((state) => state.status === "available" && !state.acknowledged)
	);
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
