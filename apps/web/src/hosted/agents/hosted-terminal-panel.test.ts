import { describe, expect, test } from "bun:test";
import {
	terminalConnectionClosedMessage,
	terminalWebSocketTarget,
} from "@/hosted/agents/hosted-terminal-panel";

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
