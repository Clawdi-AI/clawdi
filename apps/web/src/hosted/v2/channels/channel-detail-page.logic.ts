export function telegramPairDeepLink({
	deepLink,
	qrPayload,
	botUsername,
	code,
}: {
	deepLink: string | null | undefined;
	qrPayload: string | null | undefined;
	botUsername: string | null | undefined;
	code: string;
}): string | null {
	const username = botUsername?.trim().replace(/^@/, "");
	if (!deepLink || qrPayload !== deepLink || (username && !/^[A-Za-z0-9_]{5,32}$/.test(username))) {
		return null;
	}
	try {
		const url = new URL(deepLink);
		const query = [...url.searchParams.entries()];
		const linkedUsername = url.pathname.slice(1);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "t.me" ||
			url.port ||
			url.username ||
			url.password ||
			url.hash ||
			url.pathname !== `/${linkedUsername}` ||
			!/^[A-Za-z0-9_]{5,32}$/.test(linkedUsername) ||
			(username ? linkedUsername.toLowerCase() !== username.toLowerCase() : false) ||
			query.length !== 1 ||
			query[0][0] !== "start" ||
			query[0][1] !== code
		) {
			return null;
		}
		return deepLink;
	} catch {
		return null;
	}
}

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
				? "Unavailable"
				: "Details unavailable";
	const delivery =
		transport.supportsOutboundMessages === true
			? "Available"
			: transport.supportsOutboundMessages === false
				? "Unavailable"
				: "Unknown";

	return { status, connection, delivery };
}
