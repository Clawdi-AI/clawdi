import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import {
	canUseTerminalTransport,
	createTtydOutputWriter,
	type HostedTerminalStatus,
	isRetryableTerminalCloseCode,
	nextTerminalReconnect,
	TERMINAL_CONNECTION_STABILITY_MS,
	TERMINAL_RECONNECT_DELAYS_MS,
	type TerminalWebSocketTarget,
	TTYD_INPUT,
	TTYD_OUTPUT,
	TTYD_OUTPUT_CODE,
	TTYD_RESIZE,
	terminalConnectionClosedMessage,
	terminalReconnectAttemptsForClose,
	terminalWebSocketTarget,
} from "./api/terminal-protocol";

const TERMINAL_NOTICE_STYLE = "\u001b[90m";
const TERMINAL_RESET_STYLE = "\u001b[0m";
export const TERMINAL_THEMES = {
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

function writeTerminalNotice(term: XTerm, message: string) {
	term.write(`\r\n${TERMINAL_NOTICE_STYLE}[${message}]${TERMINAL_RESET_STYLE}\r\n`);
}

export async function mountTerminal(
	container: HTMLDivElement,
	options: {
		requestWebsocketUrl: () => Promise<string>;
		onStatusChange?: (status: HostedTerminalStatus) => void;
		theme: ITheme;
		links?: boolean;
	},
	signal?: AbortSignal,
) {
	let socket: WebSocket | null = null;
	const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
		import("@xterm/xterm"),
		import("@xterm/addon-fit"),
		import("@xterm/addon-web-links"),
	]);
	if (signal?.aborted) return null;

	const term = new Terminal({
		fontSize: 14,
		fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
		theme: options.theme,
		cursorBlink: true,
		...(options.links === false
			? { linkHandler: { activate: () => undefined, allowNonHttpProtocols: false } }
			: {}),
	});

	const fitAddon = new FitAddon();
	term.loadAddon(fitAddon);
	if (options.links !== false) term.loadAddon(new WebLinksAddon());
	term.open(container);
	term.focus();

	let disposed = false;
	let fitFrame: number | null = null;
	let retryTimer: number | null = null;
	let stabilityTimer: number | null = null;
	let connectionTimer: number | null = null;
	let connectionGeneration = 0;
	let reconnectAttempts = 0;
	let hasConnected = false;
	let sendCurrentSocket: ((data: string) => boolean) | null = null;

	const updateStatus = (nextStatus: HostedTerminalStatus) => {
		options.onStatusChange?.(nextStatus);
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
	const clearConnectionTimer = () => {
		if (connectionTimer === null) return;
		window.clearTimeout(connectionTimer);
		connectionTimer = null;
	};
	const closeCurrentSocket = () => {
		clearConnectionTimer();
		clearStabilityTimer();
		const current = socket;
		socket = null;
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
			`${message} Reconnecting ${reconnectAttempts}/${TERMINAL_RECONNECT_DELAYS_MS.length} in ${delaySeconds}s…`,
		);
		retryTimer = window.setTimeout(() => {
			retryTimer = null;
			void connect("automatic");
		}, nextReconnect.delayMs);
	};

	const handleConnectionFailure = (message: string, mode: "initial" | "manual" | "automatic") => {
		clearConnectionTimer();
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
			handleConnectionFailure("Secure terminal couldn't be opened.", mode);
			return;
		}
		ws.binaryType = "arraybuffer";
		socket = ws;
		let connectionStable = false;
		let transportFailed = false;

		const isCurrentTransport = () =>
			!disposed &&
			canUseTerminalTransport({
				currentGeneration: connectionGeneration,
				transportGeneration: generation,
				isCurrentSocket: socket === ws,
				failed: transportFailed,
			});
		const detachTransport = () => {
			if (socket === ws) socket = null;
			if (sendCurrentSocket === sendTransport) sendCurrentSocket = null;
			ws.onopen = null;
			ws.onmessage = null;
			ws.onclose = null;
			ws.onerror = null;
		};
		const failTransport = () => {
			if (!isCurrentTransport()) return;
			clearConnectionTimer();
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
			clearConnectionTimer();
			opened = true;
			if (!sendTransport(JSON.stringify({ AuthToken: "", columns: term.cols, rows: term.rows }))) {
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
			clearConnectionTimer();
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
		if (disposed) return;
		clearRetryTimer();
		clearStabilityTimer();
		closeCurrentSocket();
		connectionGeneration += 1;
		const generation = connectionGeneration;
		updateStatus(mode === "initial" ? "connecting" : "reconnecting");
		connectionTimer = window.setTimeout(() => {
			connectionTimer = null;
			if (disposed || generation !== connectionGeneration) return;
			// Retire late credentials and socket callbacks before closing the attempt.
			connectionGeneration += 1;
			closeCurrentSocket();
			handleConnectionFailure("Terminal connection timed out. Try again.", mode);
		}, 20_000);
		let websocketUrl: string;
		try {
			websocketUrl = await options.requestWebsocketUrl();
		} catch {
			if (disposed || generation !== connectionGeneration) return;
			handleConnectionFailure("Fresh terminal access couldn't be requested. Try again.", mode);
			return;
		}
		if (disposed || generation !== connectionGeneration) return;
		if (!websocketUrl) {
			handleConnectionFailure("Secure terminal couldn't be opened. Try again.", mode);
			return;
		}
		openWebSocket(terminalWebSocketTarget(websocketUrl), websocketUrl, mode, generation);
	}

	const reconnect = () => {
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
		if (disposed) return;
		signal?.removeEventListener("abort", cleanup);
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
	};
	signal?.addEventListener("abort", cleanup, { once: true });
	if (signal?.aborted) cleanup();
	return {
		dispose: cleanup,
		reconnect,
		setTheme: (theme: ITheme) => {
			term.options.theme = theme;
		},
		sendInput: (data: string) => {
			void sendCurrentSocket?.(TTYD_INPUT + data);
		},
	};
}
export type TerminalHandle = NonNullable<Awaited<ReturnType<typeof mountTerminal>>>;
