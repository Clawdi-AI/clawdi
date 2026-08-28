"use client";

import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef } from "react";
import { useTheme } from "@/components/theme-provider";
import "@/hosted/agents/hosted-terminal.css";

const TTYD_OUTPUT = "0";
const TTYD_OUTPUT_CODE = TTYD_OUTPUT.charCodeAt(0);
const TTYD_INPUT = "0";
const TTYD_RESIZE = "1";
const TTYD_PAUSE = "2";
const TTYD_RESUME = "3";
const TERMINAL_TOKEN_PROTOCOL_PREFIX = "clawdi-terminal.";
const TERMINAL_NOTICE_STYLE = "\u001b[90m";
const TERMINAL_RESET_STYLE = "\u001b[0m";

export const TTYD_OUTPUT_FLOW_CONTROL = {
	writeLimit: 100_000,
	highWater: 10,
	lowWater: 4,
} as const;

export const TERMINAL_RECONNECT_DELAYS_MS = [500, 1_000, 2_000] as const;
export const TERMINAL_CONNECTION_STABILITY_MS = 5_000;

export type HostedTerminalStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
type TerminalAuthMode = "subprotocol" | "query";
type TerminalThemeMode = "dark" | "light";

type TerminalWebSocketTarget = {
	url: string;
	protocols: string[];
	token: string | null;
	authMode: TerminalAuthMode;
};

type HostedTerminalPanelProps = {
	requestWebsocketUrl: () => Promise<string>;
	reconnectRequest: number;
	onStatusChange?: (status: HostedTerminalStatus) => void;
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

const TERMINAL_THEMES = {
	dark: {
		background: "#0a0a0a",
		foreground: "#e4e4e7",
		cursor: "#e4e4e7",
		selectionBackground: "#27272a",
		black: "#18181b",
		red: "#f87171",
		green: "#34d399",
		yellow: "#fbbf24",
		blue: "#60a5fa",
		magenta: "#c084fc",
		cyan: "#22d3ee",
		white: "#e4e4e7",
		brightBlack: "#71717a",
		brightRed: "#fca5a5",
		brightGreen: "#86efac",
		brightYellow: "#fde68a",
		brightBlue: "#93c5fd",
		brightMagenta: "#d8b4fe",
		brightCyan: "#67e8f9",
		brightWhite: "#fafafa",
	},
	light: {
		background: "#ffffff",
		foreground: "#18181b",
		cursor: "#18181b",
		selectionBackground: "#d4d4d8",
		black: "#27272a",
		red: "#dc2626",
		green: "#059669",
		yellow: "#ca8a04",
		blue: "#2563eb",
		magenta: "#9333ea",
		cyan: "#0891b2",
		white: "#f4f4f5",
		brightBlack: "#71717a",
		brightRed: "#ef4444",
		brightGreen: "#10b981",
		brightYellow: "#eab308",
		brightBlue: "#3b82f6",
		brightMagenta: "#a855f7",
		brightCyan: "#06b6d4",
		brightWhite: "#ffffff",
	},
} as const;

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

export function terminalConnectionClosedMessage(event: Pick<CloseEvent, "code">): string {
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

function writeTerminalNotice(term: XTerm, message: string) {
	term.write(`\r\n${TERMINAL_NOTICE_STYLE}[${message}]${TERMINAL_RESET_STYLE}\r\n`);
}

export function HostedTerminalPanel({
	requestWebsocketUrl,
	reconnectRequest,
	onStatusChange,
}: HostedTerminalPanelProps) {
	const { resolvedTheme } = useTheme();
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);
	const reconnectRef = useRef<(() => void) | null>(null);
	const reconnectRequestRef = useRef(reconnectRequest);
	const requestWebsocketUrlRef = useRef(requestWebsocketUrl);
	const onStatusChangeRef = useRef(onStatusChange);
	const terminalThemeMode: TerminalThemeMode = resolvedTheme === "dark" ? "dark" : "light";
	const terminalTheme = TERMINAL_THEMES[terminalThemeMode];
	const themeRef = useRef(terminalTheme);
	requestWebsocketUrlRef.current = requestWebsocketUrl;
	onStatusChangeRef.current = onStatusChange;

	useEffect(() => {
		themeRef.current = terminalTheme;
		if (termRef.current) {
			termRef.current.options.theme = terminalTheme;
		}
	}, [terminalTheme]);

	const initialize = useCallback(async () => {
		cleanupRef.current?.();
		cleanupRef.current = null;
		if (!containerRef.current) return;

		const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
			import("@xterm/xterm"),
			import("@xterm/addon-fit"),
			import("@xterm/addon-web-links"),
		]);
		const container = containerRef.current;
		if (!container) return;

		const term = new Terminal({
			fontSize: 14,
			fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
			theme: themeRef.current,
			cursorBlink: true,
		});

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.loadAddon(new WebLinksAddon());
		term.open(container);
		term.focus();

		let disposed = false;
		let fitFrame: number | null = null;
		let retryTimer: number | null = null;
		let stabilityTimer: number | null = null;
		let connectionGeneration = 0;
		let reconnectAttempts = 0;
		let hasConnected = false;
		let sendCurrentSocket: ((data: string) => boolean) | null = null;

		const updateStatus = (nextStatus: HostedTerminalStatus) => {
			onStatusChangeRef.current?.(nextStatus);
		};
		const clearRetryTimer = () => {
			if (retryTimer === null) return;
			window.clearTimeout(retryTimer);
			retryTimer = null;
		};
		const clearStabilityTimer = () => {
			if (stabilityTimer === null) return;
			window.clearTimeout(stabilityTimer);
			stabilityTimer = null;
		};
		const closeCurrentSocket = () => {
			clearStabilityTimer();
			const current = wsRef.current;
			wsRef.current = null;
			sendCurrentSocket = null;
			if (!current) return;
			current.onopen = null;
			current.onmessage = null;
			current.onclose = null;
			current.onerror = null;
			try {
				current.close();
			} catch {
				// A socket can finish closing between detaching its handlers and close().
			}
		};
		const fitNow = () => {
			if (fitFrame !== null) {
				window.cancelAnimationFrame(fitFrame);
				fitFrame = null;
			}
			if (!disposed) fitAddon.fit();
		};
		const scheduleFit = () => {
			if (fitFrame !== null) return;
			fitFrame = window.requestAnimationFrame(() => {
				fitFrame = null;
				if (!disposed) fitAddon.fit();
			});
		};
		fitNow();
		termRef.current = term;

		const scheduleReconnect = (message: string, closeCode: number, connectionWasStable = false) => {
			const completedAttempts = terminalReconnectAttemptsForClose(
				reconnectAttempts,
				connectionWasStable,
			);
			const nextReconnect = nextTerminalReconnect(closeCode, completedAttempts);
			if (!nextReconnect) {
				updateStatus("disconnected");
				writeTerminalNotice(term, `${message} Automatic reconnect stopped.`);
				return;
			}
			reconnectAttempts = nextReconnect.attempt;
			const delaySeconds = nextReconnect.delayMs / 1_000;
			updateStatus("reconnecting");
			writeTerminalNotice(
				term,
				`${message} Reconnecting ${reconnectAttempts}/${TERMINAL_RECONNECT_DELAYS_MS.length} in ${delaySeconds}s...`,
			);
			retryTimer = window.setTimeout(() => {
				retryTimer = null;
				void connect("automatic");
			}, nextReconnect.delayMs);
		};

		const handleConnectionFailure = (message: string, mode: "initial" | "manual" | "automatic") => {
			if (mode === "automatic") {
				scheduleReconnect(message, 1011);
				return;
			}
			updateStatus("disconnected");
			writeTerminalNotice(term, message);
		};

		const openWebSocket = (
			target: TerminalWebSocketTarget,
			websocketUrl: string,
			mode: "initial" | "manual" | "automatic",
			generation: number,
		) => {
			let ws: WebSocket;
			let opened = false;
			try {
				ws = new WebSocket(target.url, target.protocols);
			} catch {
				if (target.authMode === "subprotocol" && target.token) {
					openWebSocket(
						terminalWebSocketTarget(websocketUrl, "query"),
						websocketUrl,
						mode,
						generation,
					);
					return;
				}
				handleConnectionFailure("Secure terminal could not be opened.", mode);
				return;
			}
			ws.binaryType = "arraybuffer";
			wsRef.current = ws;
			let connectionStable = false;
			let transportFailed = false;

			const isCurrentTransport = () =>
				!disposed &&
				canUseTerminalTransport({
					currentGeneration: connectionGeneration,
					transportGeneration: generation,
					isCurrentSocket: wsRef.current === ws,
					failed: transportFailed,
				});
			const detachTransport = () => {
				if (wsRef.current === ws) wsRef.current = null;
				if (sendCurrentSocket === sendTransport) sendCurrentSocket = null;
				ws.onopen = null;
				ws.onmessage = null;
				ws.onclose = null;
				ws.onerror = null;
			};
			const failTransport = () => {
				if (!isCurrentTransport()) return;
				transportFailed = true;
				clearStabilityTimer();
				detachTransport();
				try {
					ws.close();
				} catch {
					// The retry no longer depends on the browser's eventual close event.
				}
				scheduleReconnect("Terminal transport failed.", 1011, connectionStable);
			};
			const sendTransport = (data: string): boolean => {
				if (!isCurrentTransport() || ws.readyState !== WebSocket.OPEN) return false;
				try {
					ws.send(data);
					return true;
				} catch {
					failTransport();
					return false;
				}
			};
			const writeOutput = createTtydOutputWriter({
				write: (data, callback) => term.write(data, callback),
				send: (command) => {
					void sendTransport(command);
				},
			});
			sendCurrentSocket = sendTransport;

			ws.onopen = () => {
				if (!isCurrentTransport()) return;
				opened = true;
				if (
					!sendTransport(JSON.stringify({ AuthToken: "", columns: term.cols, rows: term.rows }))
				) {
					return;
				}
				const reconnected = hasConnected || mode !== "initial";
				hasConnected = true;
				updateStatus("connected");
				if (reconnected) writeTerminalNotice(term, "Terminal reconnected.");
				term.focus();
				clearStabilityTimer();
				stabilityTimer = window.setTimeout(() => {
					stabilityTimer = null;
					if (isCurrentTransport() && ws.readyState === WebSocket.OPEN) {
						connectionStable = true;
					}
				}, TERMINAL_CONNECTION_STABILITY_MS);
			};

			ws.onmessage = (ev) => {
				if (!isCurrentTransport()) return;
				if (ev.data instanceof ArrayBuffer) {
					const data = new Uint8Array(ev.data);
					if (data[0] === TTYD_OUTPUT_CODE) writeOutput(data.subarray(1));
					return;
				}
				if (typeof ev.data === "string" && ev.data[0] === TTYD_OUTPUT) {
					writeOutput(ev.data.slice(1));
				}
			};

			ws.onclose = (event) => {
				if (!isCurrentTransport()) return;
				transportFailed = true;
				clearStabilityTimer();
				detachTransport();
				if (!opened && event.code === 1006 && target.authMode === "subprotocol" && target.token) {
					openWebSocket(
						terminalWebSocketTarget(websocketUrl, "query"),
						websocketUrl,
						mode,
						generation,
					);
					return;
				}
				const message = terminalConnectionClosedMessage(event);
				if (isRetryableTerminalCloseCode(event.code)) {
					scheduleReconnect(message, event.code, connectionStable);
					return;
				}
				updateStatus("disconnected");
				writeTerminalNotice(term, message);
			};
			ws.onerror = () => undefined;
		};

		async function connect(mode: "initial" | "manual" | "automatic") {
			clearRetryTimer();
			clearStabilityTimer();
			closeCurrentSocket();
			connectionGeneration += 1;
			const generation = connectionGeneration;
			updateStatus(mode === "initial" ? "connecting" : "reconnecting");
			let websocketUrl: string;
			try {
				websocketUrl = await requestWebsocketUrlRef.current();
			} catch {
				if (disposed || generation !== connectionGeneration) return;
				handleConnectionFailure("Fresh terminal access could not be requested. Try again.", mode);
				return;
			}
			if (disposed || generation !== connectionGeneration) return;
			if (!websocketUrl) {
				handleConnectionFailure("Secure terminal could not be opened. Try again.", mode);
				return;
			}
			openWebSocket(terminalWebSocketTarget(websocketUrl), websocketUrl, mode, generation);
		}

		reconnectRef.current = () => {
			reconnectAttempts = 0;
			void connect("manual");
		};
		void connect("initial");

		term.onData((data) => {
			void sendCurrentSocket?.(TTYD_INPUT + data);
		});
		term.onResize(({ cols, rows }) => {
			void sendCurrentSocket?.(TTYD_RESIZE + JSON.stringify({ columns: cols, rows }));
		});

		const resizeObserver = new ResizeObserver(scheduleFit);
		resizeObserver.observe(container);
		const focusTerminal = () => term.focus();
		container.addEventListener("pointerdown", focusTerminal);

		const cleanup = () => {
			disposed = true;
			connectionGeneration += 1;
			clearRetryTimer();
			clearStabilityTimer();
			if (fitFrame !== null) {
				window.cancelAnimationFrame(fitFrame);
				fitFrame = null;
			}
			resizeObserver.disconnect();
			container.removeEventListener("pointerdown", focusTerminal);
			closeCurrentSocket();
			term.dispose();
			termRef.current = null;
			reconnectRef.current = null;
		};
		cleanupRef.current = cleanup;
		return cleanup;
	}, []);

	useEffect(() => {
		let cancelled = false;
		initialize()
			.then((fn) => {
				if (cancelled) fn?.();
			})
			.catch(() => {
				if (!cancelled) onStatusChangeRef.current?.("disconnected");
			});
		return () => {
			cancelled = true;
			cleanupRef.current?.();
			cleanupRef.current = null;
		};
	}, [initialize]);

	useEffect(() => {
		if (reconnectRequestRef.current === reconnectRequest) return;
		reconnectRequestRef.current = reconnectRequest;
		reconnectRef.current?.();
	}, [reconnectRequest]);

	return (
		<div data-hosted="true" className="flex min-h-0 flex-1 flex-col">
			<div
				ref={containerRef}
				data-terminal-theme={terminalThemeMode}
				className="hosted-terminal min-h-0 flex-1 overflow-hidden p-2 transition-colors"
			/>
		</div>
	);
}
