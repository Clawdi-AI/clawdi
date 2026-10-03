export const TTYD_OUTPUT = "0";
export const TTYD_OUTPUT_CODE = TTYD_OUTPUT.charCodeAt(0);
export const TTYD_INPUT = "0";
export const TTYD_RESIZE = "1";
export const TTYD_PAUSE = "2";
export const TTYD_RESUME = "3";
export const TERMINAL_TOKEN_PROTOCOL_PREFIX = "clawdi-terminal.";
export const TTYD_OUTPUT_FLOW_CONTROL = {
	writeLimit: 100_000,
	highWater: 10,
	lowWater: 4,
} as const;

export const TERMINAL_RECONNECT_DELAYS_MS = [500, 1_000, 2_000] as const;
export const TERMINAL_CONNECTION_STABILITY_MS = 5_000;

export type HostedTerminalStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
export type TerminalAuthMode = "subprotocol" | "query";

export type TerminalWebSocketTarget = {
	url: string;
	protocols: string[];
	token: string | null;
	authMode: TerminalAuthMode;
};

type TtydFlowControlCommand = typeof TTYD_PAUSE | typeof TTYD_RESUME;

export function createTtydOutputWriter({
	write,
	send,
}: {
	write: (data: string | Uint8Array, callback?: () => void) => void;
	send: (command: TtydFlowControlCommand) => void;
}): (data: string | Uint8Array) => void {
	let written = 0;
	let pending = 0;

	return (data) => {
		written += data.length;
		if (written > TTYD_OUTPUT_FLOW_CONTROL.writeLimit) {
			write(data, () => {
				pending = Math.max(pending - 1, 0);
				if (pending < TTYD_OUTPUT_FLOW_CONTROL.lowWater) send(TTYD_RESUME);
			});
			pending += 1;
			written = 0;
			if (pending > TTYD_OUTPUT_FLOW_CONTROL.highWater) send(TTYD_PAUSE);
		} else {
			write(data);
		}
	};
}

export function terminalWebSocketTarget(
	websocketUrl: string,
	authMode: TerminalAuthMode = "subprotocol",
): TerminalWebSocketTarget {
	const protocols = ["tty"];
	try {
		const parsed = new URL(websocketUrl);
		const queryToken = parsed.searchParams.get("token");
		const fragmentToken = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token");
		const token = queryToken || fragmentToken;
		parsed.hash = "";
		if (!token) return { url: parsed.toString(), protocols, token: null, authMode };
		if (queryToken || authMode === "query") {
			parsed.searchParams.set("token", token);
			return {
				url: parsed.toString(),
				protocols,
				token,
				authMode: "query",
			};
		}
		return {
			url: parsed.toString(),
			protocols: [...protocols, `${TERMINAL_TOKEN_PROTOCOL_PREFIX}${token}`],
			token,
			authMode: "subprotocol",
		};
	} catch {
		return { url: websocketUrl, protocols, token: null, authMode };
	}
}

export function isRetryableTerminalCloseCode(code: number): boolean {
	return code === 1006 || code === 1011 || code === 1013;
}

export type TerminalReconnectState = {
	attempt: number;
	delayMs: (typeof TERMINAL_RECONNECT_DELAYS_MS)[number];
};

export function nextTerminalReconnect(
	closeCode: number,
	completedAttempts: number,
): TerminalReconnectState | null {
	if (!isRetryableTerminalCloseCode(closeCode)) return null;
	const delayMs = TERMINAL_RECONNECT_DELAYS_MS[completedAttempts];
	return delayMs === undefined ? null : { attempt: completedAttempts + 1, delayMs };
}

export function terminalReconnectAttemptsForClose(
	completedAttempts: number,
	connectionWasStable: boolean,
): number {
	return connectionWasStable ? 0 : completedAttempts;
}

export function canUseTerminalTransport({
	currentGeneration,
	transportGeneration,
	isCurrentSocket,
	failed,
}: {
	currentGeneration: number;
	transportGeneration: number;
	isCurrentSocket: boolean;
	failed: boolean;
}): boolean {
	return !failed && currentGeneration === transportGeneration && isCurrentSocket;
}

export function terminalConnectionClosedMessage(event: { code: number }): string {
	switch (event.code) {
		case 1000:
			return "Shell exited normally. Reconnect to start a new session.";
		case 1006:
			return "Terminal connection was interrupted.";
		case 1008:
			return "Terminal access was rejected. Reconnect to request fresh access.";
		case 1011:
			return "Terminal service encountered a temporary problem.";
		case 1013:
			return "Terminal service is temporarily unavailable.";
		default:
			return `Terminal connection closed (code ${event.code}).`;
	}
}
