import { describe, expect, test } from "bun:test";
import {
	chatwootColorSchemeScript,
	chatwootWidgetScript,
	isChatwootCloseMessage,
	isChatwootWidgetUrl,
	supportChatContext,
	supportChatParams,
} from "@/lib/chatwoot";

/** Runs the injected script against a stub window and decodes what the widget receives. */
function widgetMessages(script: string): unknown[] {
	const posted: string[] = [];
	new Function("window", script)({ postMessage: (data: string) => posted.push(data) });
	return posted.map((data) => {
		expect(data.startsWith("chatwoot-widget:")).toBe(true);
		return JSON.parse(data.slice("chatwoot-widget:".length));
	});
}

const identity = {
	id: "user_123",
	name: `Ada "</script><script>alert(1)</script>`,
	email: "ada@example.com",
};

describe("Chatwoot widget script", () => {
	test("identifies the contact like the Web SDK, keeping hostile names inert", () => {
		expect(
			widgetMessages(
				chatwootWidgetScript({
					identity,
					identifierHash: "hash",
					colorScheme: "dark",
					context: null,
				}),
			),
		).toEqual([
			{
				event: "set-user",
				identifier: "user_123",
				user: { name: identity.name, email: identity.email, identifier_hash: "hash" },
			},
			{ event: "set-locale", locale: "en" },
			{ event: "set-color-scheme", darkMode: "dark" },
		]);
	});

	test("Contact support's context reaches the conversation through route params", () => {
		const context = supportChatContext(
			supportChatParams({
				conversationAttributes: { setup_deployment_id: "hdep_1", setup_elapsed_seconds: 42 },
				label: "agent-setup",
			}),
		);
		expect(
			widgetMessages(
				chatwootWidgetScript({ identity, identifierHash: "hash", colorScheme: "light", context }),
			).slice(3),
		).toEqual([
			{
				event: "set-conversation-custom-attributes",
				customAttributes: { setup_deployment_id: "hdep_1", setup_elapsed_seconds: 42 },
			},
			{ event: "set-label", label: "agent-setup" },
		]);
	});

	test("a later theme change sends only the widget's color scheme", () => {
		expect(widgetMessages(chatwootColorSchemeScript("dark"))).toEqual([
			{ event: "set-color-scheme", darkMode: "dark" },
		]);
	});

	test("ignores malformed context params", () => {
		for (const attributes of ["", "[]", "{", '{"nested":{"a":1}}'])
			expect(supportChatContext({ label: "agent-setup", attributes })).toBeNull();
		expect(supportChatContext({})).toBeNull();
	});
});

describe("Chatwoot widget navigation", () => {
	test("recognizes the widget's close button", () => {
		expect(isChatwootCloseMessage('chatwoot-widget:{"type":"close-widget"}')).toBe(true);
		expect(isChatwootCloseMessage('{"event":"loaded"}')).toBe(false);
		expect(isChatwootCloseMessage("not json")).toBe(false);
	});

	test("keeps navigation on the widget origin", () => {
		const base = "https://chat.example.test";
		expect(isChatwootWidgetUrl(`${base}/widget?website_token=x`, base)).toBe(true);
		expect(isChatwootWidgetUrl("https://chat.example.test.evil.test/widget", base)).toBe(false);
		expect(isChatwootWidgetUrl("https://example.com/attachment.pdf", base)).toBe(false);
	});
});
