"use client";
import type { HostedTerminalStatus } from "@clawdi/shared/api";
import { mountTerminal, TERMINAL_THEMES, type TerminalHandle } from "@clawdi/shared/terminal";
import { useEffect, useRef } from "react";
import { useTheme } from "@/components/theme-provider";
import "@/hosted/agents/hosted-terminal.css";

export {
	canUseTerminalTransport,
	createTtydOutputWriter,
	type HostedTerminalStatus,
	isRetryableTerminalCloseCode,
	nextTerminalReconnect,
	TERMINAL_CONNECTION_STABILITY_MS,
	TERMINAL_RECONNECT_DELAYS_MS,
	type TerminalReconnectState,
	TTYD_OUTPUT_FLOW_CONTROL,
	terminalConnectionClosedMessage,
	terminalReconnectAttemptsForClose,
	terminalWebSocketTarget,
} from "@clawdi/shared/api";

export function HostedTerminalPanel({
	requestWebsocketUrl,
	reconnectRequest,
	onStatusChange,
}: {
	requestWebsocketUrl: () => Promise<string>;
	reconnectRequest: number;
	onStatusChange?: (status: HostedTerminalStatus) => void;
}) {
	const { resolvedTheme } = useTheme();
	const container = useRef<HTMLDivElement>(null);
	const handle = useRef<TerminalHandle | null>(null);
	const request = useRef(requestWebsocketUrl);
	request.current = requestWebsocketUrl;
	const status = useRef(onStatusChange);
	status.current = onStatusChange;
	const theme = TERMINAL_THEMES[resolvedTheme === "dark" ? "dark" : "light"];
	const currentTheme = useRef(theme);
	currentTheme.current = theme;
	const previousReconnect = useRef(reconnectRequest);
	useEffect(() => {
		if (!container.current) return;
		const controller = new AbortController();
		void mountTerminal(
			container.current,
			{
				requestWebsocketUrl: () => request.current(),
				onStatusChange: (value) => status.current?.(value),
				theme: currentTheme.current,
			},
			controller.signal,
		)
			.then((instance) => {
				if (controller.signal.aborted) instance?.dispose();
				else {
					handle.current = instance;
					instance?.setTheme(currentTheme.current);
				}
			})
			.catch(() => {
				if (!controller.signal.aborted) status.current?.("disconnected");
			});
		return () => {
			controller.abort();
			handle.current?.dispose();
			handle.current = null;
		};
	}, []);
	useEffect(() => {
		handle.current?.setTheme(theme);
	}, [theme]);
	useEffect(() => {
		if (previousReconnect.current === reconnectRequest) return;
		previousReconnect.current = reconnectRequest;
		handle.current?.reconnect();
	}, [reconnectRequest]);
	return (
		<div data-hosted="true" className="flex min-h-0 flex-1 flex-col">
			<div
				ref={container}
				data-terminal-theme={resolvedTheme === "dark" ? "dark" : "light"}
				className="hosted-terminal min-h-0 flex-1 overflow-hidden transition-colors"
			/>
		</div>
	);
}
