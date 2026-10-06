"use dom";

import type { HostedTerminalStatus } from "@clawdi/shared/api";
import { mountTerminal, TERMINAL_THEMES, type TerminalHandle } from "@clawdi/shared/terminal";
import type { DOMProps } from "expo/dom";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

export default function TerminalDom({
	requestWebsocketUrl,
	onStatusChange,
	dark,
	input,
	reconnectRequest,
}: {
	dom?: DOMProps;
	requestWebsocketUrl: () => Promise<string>;
	onStatusChange: (status: HostedTerminalStatus) => Promise<void>;
	dark: boolean;
	input: { sequence: number; value: string };
	reconnectRequest: number;
}) {
	const container = useRef<HTMLDivElement>(null);
	const handle = useRef<TerminalHandle | null>(null);
	const request = useRef(requestWebsocketUrl);
	request.current = requestWebsocketUrl;
	const status = useRef(onStatusChange);
	status.current = onStatusChange;
	const theme = TERMINAL_THEMES[dark ? "dark" : "light"];
	const currentTheme = useRef(theme);
	currentTheme.current = theme;
	const previousInput = useRef(input.sequence);
	const previousReconnect = useRef(reconnectRequest);
	useEffect(() => {
		if (!container.current) return;
		const controller = new AbortController();
		void mountTerminal(
			container.current,
			{
				requestWebsocketUrl: () => request.current(),
				onStatusChange: (value) => {
					void status.current(value).catch(() => undefined);
				},
				theme: currentTheme.current,
				links: false,
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
				if (!controller.signal.aborted) void status.current("disconnected").catch(() => undefined);
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
	useEffect(() => {
		if (previousInput.current === input.sequence) return;
		previousInput.current = input.sequence;
		handle.current?.sendInput(input.value);
	}, [input]);
	return (
		<div
			ref={container}
			style={{ position: "fixed", inset: 0, overflow: "hidden", backgroundColor: theme.background }}
		/>
	);
}
