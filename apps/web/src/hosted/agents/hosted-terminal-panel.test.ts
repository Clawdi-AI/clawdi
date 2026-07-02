import { describe, expect, test } from "bun:test";
import {
	terminalConnectionClosedMessage,
	terminalWebSocketTarget,
} from "@/hosted/agents/hosted-terminal-panel";

describe("terminalWebSocketTarget", () => {
	test("moves a fragment token into a websocket subprotocol", () => {
		const target = terminalWebSocketTarget(
			"wss://api.example.test/v2/deployments/hdep_123/terminal/ws#token=header.payload.signature",
		);

		expect(target.url).toBe("wss://api.example.test/v2/deployments/hdep_123/terminal/ws");
		expect(target.protocols).toEqual(["tty", "clawdi-terminal.header.payload.signature"]);
		expect(target.token).toBe("header.payload.signature");
	});

	test("removes a query token without treating it as terminal auth", () => {
		const target = terminalWebSocketTarget(
			"wss://api.example.test/v2/deployments/hdep_123/terminal/ws?token=header.payload.signature",
		);

		expect(target.url).toBe("wss://api.example.test/v2/deployments/hdep_123/terminal/ws");
		expect(target.protocols).toEqual(["tty"]);
		expect(target.token).toBeNull();
	});

	test("preserves existing query params while stripping the token", () => {
		const target = terminalWebSocketTarget(
			"wss://api.example.test/v2/deployments/hdep_123/terminal/ws?trace=1#token=tok",
		);

		expect(target.url).toBe("wss://api.example.test/v2/deployments/hdep_123/terminal/ws?trace=1");
		expect(target.protocols).toEqual(["tty", "clawdi-terminal.tok"]);
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
