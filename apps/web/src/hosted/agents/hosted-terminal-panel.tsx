"use client";

import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const TTYD_OUTPUT = "0";
const TTYD_INPUT = "0";
const TTYD_RESIZE = "1";
const TERMINAL_TOKEN_PROTOCOL_PREFIX = "clawdi-terminal.";

type HostedTerminalPanelProps = {
	websocketUrl: string;
};

function terminalWebSocketTarget(websocketUrl: string): { url: string; protocols: string[] } {
	const protocols = ["tty"];
	try {
		const parsed = new URL(websocketUrl);
		const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token");
		if (!token) return { url: websocketUrl, protocols };
		parsed.hash = "";
		return {
			url: parsed.toString(),
			protocols: [...protocols, `${TERMINAL_TOKEN_PROTOCOL_PREFIX}${token}`],
		};
	} catch {
		return { url: websocketUrl, protocols };
	}
}

export function HostedTerminalPanel({ websocketUrl }: HostedTerminalPanelProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const fitRef = useRef<FitAddonType | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);
	const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("disconnected");
	const { url: wsUrl, protocols } = terminalWebSocketTarget(websocketUrl);
	const wsProtocols = protocols.join(",");

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
			theme: {
				background: "#0a0a0a",
				foreground: "#e4e4e7",
				cursor: "#e4e4e7",
				selectionBackground: "#27272a",
			},
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

		const ws = new WebSocket(wsUrl, wsProtocols.split(","));
		ws.binaryType = "arraybuffer";
		wsRef.current = ws;
		let disposed = false;

		ws.onopen = () => {
			if (disposed) return;
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

		ws.onclose = () => {
			if (disposed) return;
			setStatus("disconnected");
			term.write("\r\n\u001b[90m[terminal connection closed]\u001b[0m\r\n");
		};
		ws.onerror = () => {
			if (!disposed) setStatus("disconnected");
		};

		term.onData((data) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(TTYD_INPUT + data);
			}
		});
		term.onResize(({ cols, rows }) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(TTYD_RESIZE + JSON.stringify({ columns: cols, rows }));
			}
		});

		const resizeObserver = new ResizeObserver(() => fitAddon.fit());
		resizeObserver.observe(container);

		const cleanup = () => {
			disposed = true;
			resizeObserver.disconnect();
			ws.close();
			term.dispose();
			termRef.current = null;
			fitRef.current = null;
			wsRef.current = null;
		};
		cleanupRef.current = cleanup;
		return cleanup;
	}, [wsUrl, wsProtocols]);

	useEffect(() => {
		let cancelled = false;
		connect().then((fn) => {
			if (cancelled) fn?.();
		});
		return () => {
			cancelled = true;
			cleanupRef.current?.();
			cleanupRef.current = null;
		};
	}, [connect]);

	return (
		<div data-hosted="true" className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<span
						className={
							status === "connected"
								? "size-2 rounded-full bg-emerald-500"
								: status === "connecting"
									? "size-2 rounded-full bg-amber-500"
									: "size-2 rounded-full bg-destructive"
						}
					/>
					{status}
				</div>
				{status === "disconnected" ? (
					<Button type="button" variant="ghost" size="sm" onClick={() => void connect()}>
						Reconnect
					</Button>
				) : null}
			</div>
			<div ref={containerRef} className="min-h-0 flex-1 bg-[#0a0a0a] p-1" />
		</div>
	);
}
