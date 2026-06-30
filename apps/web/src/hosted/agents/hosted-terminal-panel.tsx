"use client";

import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";

const TTYD_OUTPUT = "0";
const TTYD_INPUT = "0";
const TTYD_RESIZE = "1";
const TERMINAL_TOKEN_PROTOCOL_PREFIX = "clawdi-terminal.";
const TERMINAL_NOTICE_STYLE = "\u001b[90m";
const TERMINAL_RESET_STYLE = "\u001b[0m";
const TERMINAL_CLOSE_REASON_MAX_LENGTH = 120;

export type HostedTerminalStatus = "connecting" | "connected" | "disconnected";
type TerminalAuthMode = "subprotocol" | "query";
type TerminalThemeMode = "dark" | "light";

type TerminalWebSocketTarget = {
	url: string;
	protocols: string[];
	token: string | null;
	authMode: TerminalAuthMode;
};

type HostedTerminalPanelProps = {
	websocketUrl: string;
	onStatusChange?: (status: HostedTerminalStatus) => void;
};

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

function sanitizedCloseReason(reason: string): string {
	return Array.from(reason, (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 ? " " : char;
	})
		.join("")
		.trim()
		.slice(0, TERMINAL_CLOSE_REASON_MAX_LENGTH);
}

export function terminalConnectionClosedMessage(event: CloseEvent): string {
	const reason = sanitizedCloseReason(event.reason);
	return `terminal connection closed: code ${event.code}${reason ? `, ${reason}` : ""}`;
}

function writeTerminalNotice(term: XTerm, message: string) {
	term.write(`\r\n${TERMINAL_NOTICE_STYLE}[${message}]${TERMINAL_RESET_STYLE}\r\n`);
}

export function HostedTerminalPanel({ websocketUrl, onStatusChange }: HostedTerminalPanelProps) {
	const { resolvedTheme } = useTheme();
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const fitRef = useRef<FitAddonType | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);
	const terminalThemeMode: TerminalThemeMode = resolvedTheme === "dark" ? "dark" : "light";
	const terminalTheme = TERMINAL_THEMES[terminalThemeMode];
	const themeRef = useRef(terminalTheme);
	const [status, setStatus] = useState<HostedTerminalStatus>("connecting");

	useEffect(() => {
		onStatusChange?.(status);
	}, [onStatusChange, status]);

	useEffect(() => {
		themeRef.current = terminalTheme;
		if (termRef.current) {
			termRef.current.options.theme = terminalTheme;
		}
	}, [terminalTheme]);

	const connect = useCallback(async () => {
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
			allowProposedApi: true,
		});

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.loadAddon(new WebLinksAddon());
		term.open(container);
		fitAddon.fit();

		termRef.current = term;
		fitRef.current = fitAddon;
		setStatus("connecting");

		let disposed = false;

		const openWebSocket = (target: TerminalWebSocketTarget) => {
			let ws: WebSocket;
			let opened = false;
			try {
				ws = new WebSocket(target.url, target.protocols);
			} catch {
				if (target.authMode === "subprotocol" && target.token) {
					openWebSocket(terminalWebSocketTarget(websocketUrl, "query"));
					return;
				}
				setStatus("disconnected");
				writeTerminalNotice(term, "terminal websocket could not be opened");
				return;
			}
			ws.binaryType = "arraybuffer";
			wsRef.current = ws;

			ws.onopen = () => {
				if (disposed) return;
				opened = true;
				setStatus("connected");
				ws.send(JSON.stringify({ AuthToken: "", columns: term.cols, rows: term.rows }));
			};

			ws.onmessage = (ev) => {
				if (disposed) return;
				const data =
					ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : (ev.data as string);
				if (data.length === 0) return;
				if (data[0] === TTYD_OUTPUT) {
					term.write(data.slice(1));
				}
			};

			ws.onclose = (event) => {
				if (disposed) return;
				if (wsRef.current === ws) {
					wsRef.current = null;
				}
				if (!opened && target.authMode === "subprotocol" && target.token) {
					setStatus("connecting");
					openWebSocket(terminalWebSocketTarget(websocketUrl, "query"));
					return;
				}
				setStatus("disconnected");
				writeTerminalNotice(term, terminalConnectionClosedMessage(event));
			};
			ws.onerror = () => {
				if (!opened && target.authMode === "subprotocol" && target.token) return;
				if (!disposed) setStatus("disconnected");
			};
		};

		openWebSocket(terminalWebSocketTarget(websocketUrl));

		term.onData((data) => {
			const ws = wsRef.current;
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(TTYD_INPUT + data);
			}
		});
		term.onResize(({ cols, rows }) => {
			const ws = wsRef.current;
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(TTYD_RESIZE + JSON.stringify({ columns: cols, rows }));
			}
		});

		const resizeObserver = new ResizeObserver(() => fitAddon.fit());
		resizeObserver.observe(container);

		const cleanup = () => {
			disposed = true;
			resizeObserver.disconnect();
			wsRef.current?.close();
			term.dispose();
			termRef.current = null;
			fitRef.current = null;
			wsRef.current = null;
		};
		cleanupRef.current = cleanup;
		return cleanup;
	}, [websocketUrl]);

	useEffect(() => {
		let cancelled = false;
		connect()
			.then((fn) => {
				if (cancelled) fn?.();
			})
			.catch(() => {
				if (!cancelled) setStatus("disconnected");
			});
		return () => {
			cancelled = true;
			cleanupRef.current?.();
			cleanupRef.current = null;
		};
	}, [connect]);

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
