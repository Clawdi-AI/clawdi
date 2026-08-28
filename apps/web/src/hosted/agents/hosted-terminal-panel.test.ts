import { describe, expect, test } from "bun:test";
import {
	createTtydOutputWriter,
	TTYD_OUTPUT_FLOW_CONTROL,
	terminalConnectionClosedMessage,
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
	test("formats close code without leaking control characters from reason", () => {
		const event = new CloseEvent("close", {
			code: 1008,
			reason: "policy\u0000violation",
		});

		expect(terminalConnectionClosedMessage(event)).toBe(
			"terminal connection closed: code 1008, policy violation",
		);
	});
});
