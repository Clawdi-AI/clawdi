import { describe, expect, test } from "bun:test";
import {
	canUseTerminalTransport,
	createTtydOutputWriter,
	isRetryableTerminalCloseCode,
	nextTerminalReconnect,
	TERMINAL_CONNECTION_STABILITY_MS,
	TERMINAL_RECONNECT_DELAYS_MS,
	TTYD_OUTPUT_FLOW_CONTROL,
	terminalConnectionClosedMessage,
	terminalReconnectAttemptsForClose,
	terminalWebSocketTarget,
} from "@/hosted/agents/hosted-terminal-panel";

describe("terminal output flow control", () => {
	test("bounds pending xterm writes with ttyd pause and resume commands", () => {
		expect(TTYD_OUTPUT_FLOW_CONTROL).toEqual({
			writeLimit: 100_000,
			highWater: 10,
			lowWater: 4,
		});
		const callbacks: Array<() => void> = [];
		const commands: string[] = [];
		const writeOutput = createTtydOutputWriter({
			write: (_data, callback) => {
				if (callback) callbacks.push(callback);
			},
			send: (command) => {
				commands.push(command);
			},
		});
		const checkpoint = "x".repeat(TTYD_OUTPUT_FLOW_CONTROL.writeLimit + 1);

		for (let index = 0; index <= TTYD_OUTPUT_FLOW_CONTROL.highWater; index += 1) {
			writeOutput(checkpoint);
		}
		expect(callbacks).toHaveLength(11);
		expect(commands).toEqual(["2"]);

		writeOutput(checkpoint);
		expect(commands).toEqual(["2", "2"]);
		while (callbacks.length > TTYD_OUTPUT_FLOW_CONTROL.lowWater) callbacks.shift()?.();
		expect(commands).toEqual(["2", "2"]);
		callbacks.shift()?.();
		expect(commands).toEqual(["2", "2", "3"]);
	});

	test("keeps ordinary output on the callback-free fast path", () => {
		const callbacks: Array<(() => void) | undefined> = [];
		const commands: string[] = [];
		const writeOutput = createTtydOutputWriter({
			write: (_data, callback) => callbacks.push(callback),
			send: (command) => {
				commands.push(command);
			},
		});

		writeOutput("normal output");
		expect(callbacks).toEqual([undefined]);
		expect(commands).toEqual([]);
	});

	test("does not let an old write callback resume a replacement transport", () => {
		const callbacks: Array<() => void> = [];
		const commands: string[] = [];
		let currentGeneration = 1;
		let isCurrentSocket = true;
		const writeOutput = createTtydOutputWriter({
			write: (_data, callback) => {
				if (callback) callbacks.push(callback);
			},
			send: (command) => {
				if (
					canUseTerminalTransport({
						currentGeneration,
						transportGeneration: 1,
						isCurrentSocket,
						failed: false,
					})
				) {
					commands.push(command);
				}
			},
		});
		const checkpoint = "x".repeat(TTYD_OUTPUT_FLOW_CONTROL.writeLimit + 1);

		for (let index = 0; index < TTYD_OUTPUT_FLOW_CONTROL.lowWater; index += 1) {
			writeOutput(checkpoint);
		}
		currentGeneration = 2;
		isCurrentSocket = false;
		callbacks.shift()?.();

		expect(commands).toEqual([]);
	});
});

describe("terminal reconnect policy", () => {
	test("retries only abnormal and explicitly temporary closes", () => {
		for (const code of [1006, 1011, 1013]) {
			expect(isRetryableTerminalCloseCode(code)).toBe(true);
		}
		for (const code of [1000, 1001, 1008, 1012, 4000]) {
			expect(isRetryableTerminalCloseCode(code)).toBe(false);
		}
	});

	test("uses a finite exponential retry sequence", () => {
		expect(TERMINAL_RECONNECT_DELAYS_MS).toEqual([500, 1_000, 2_000]);
		expect(nextTerminalReconnect(1011, 0)).toEqual({ attempt: 1, delayMs: 500 });
		expect(nextTerminalReconnect(1011, 1)).toEqual({ attempt: 2, delayMs: 1_000 });
		expect(nextTerminalReconnect(1011, 2)).toEqual({ attempt: 3, delayMs: 2_000 });
		expect(nextTerminalReconnect(1011, 3)).toBeNull();
		expect(nextTerminalReconnect(1000, 0)).toBeNull();
		expect(nextTerminalReconnect(1008, 0)).toBeNull();
	});

	test("resets retry budget only after a connection is stable", () => {
		expect(TERMINAL_CONNECTION_STABILITY_MS).toBe(5_000);
		expect(nextTerminalReconnect(1011, terminalReconnectAttemptsForClose(2, false))).toEqual({
			attempt: 3,
			delayMs: 2_000,
		});
		expect(nextTerminalReconnect(1011, terminalReconnectAttemptsForClose(2, true))).toEqual({
			attempt: 1,
			delayMs: 500,
		});
	});

	test("uses one transport-failure transition per current socket", () => {
		const current = {
			currentGeneration: 4,
			transportGeneration: 4,
			isCurrentSocket: true,
		};

		expect(canUseTerminalTransport({ ...current, failed: false })).toBe(true);
		expect(canUseTerminalTransport({ ...current, failed: true })).toBe(false);
		expect(canUseTerminalTransport({ ...current, transportGeneration: 3, failed: false })).toBe(
			false,
		);
	});
});

describe("terminalWebSocketTarget", () => {
	test("moves a fragment token into a websocket subprotocol by default", () => {
		const target = terminalWebSocketTarget(
			"wss://api.example.test/v2/deployments/hdep_123/terminal/ws#token=header.payload.signature",
		);

		expect(target.url).toBe("wss://api.example.test/v2/deployments/hdep_123/terminal/ws");
		expect(target.protocols).toEqual(["tty", "clawdi-terminal.header.payload.signature"]);
		expect(target.authMode).toBe("subprotocol");
		expect(target.token).toBe("header.payload.signature");
	});

	test("can fall back to query-token auth when subprotocol auth is not viable", () => {
		const target = terminalWebSocketTarget(
			"wss://api.example.test/v2/deployments/hdep_123/terminal/ws#token=header.payload.signature",
			"query",
		);

		expect(target.url).toBe(
			"wss://api.example.test/v2/deployments/hdep_123/terminal/ws?token=header.payload.signature",
		);
		expect(target.protocols).toEqual(["tty"]);
		expect(target.authMode).toBe("query");
	});

	test("preserves existing query params when adding the fallback token", () => {
		const target = terminalWebSocketTarget(
			"wss://api.example.test/v2/deployments/hdep_123/terminal/ws?trace=1#token=tok",
			"query",
		);

		expect(target.url).toBe(
			"wss://api.example.test/v2/deployments/hdep_123/terminal/ws?trace=1&token=tok",
		);
		expect(target.protocols).toEqual(["tty"]);
	});
});

describe("terminalConnectionClosedMessage", () => {
	test("uses safe status copy without exposing a backend close reason", () => {
		const event = new CloseEvent("close", {
			code: 1011,
			reason: "upstream postgres connection failed at internal-host:5432",
		});

		const message = terminalConnectionClosedMessage(event);
		expect(message).toBe("Terminal service encountered a temporary problem.");
		expect(message).not.toContain("postgres");
		expect(terminalConnectionClosedMessage({ code: 1000 })).toContain("exited normally");
		expect(terminalConnectionClosedMessage({ code: 1008 })).toContain("access was rejected");
	});
});
