import { describe, expect, test } from "bun:test";
import { pairedChatScopeLabel, pairedChatTitle } from "@/hosted/v2/channels/paired-chat-row.logic";

describe("pairedChatTitle", () => {
	test("uses only the chat name when one is available", () => {
		expect(
			pairedChatTitle({
				external_chat_id: "123456789",
				external_chat_name: "Support team",
				external_chat_type: "private",
			}),
		).toBe("Support team");
	});

	test("keeps anonymous private chats identifiable by external chat id", () => {
		expect(
			pairedChatTitle({
				external_chat_id: "123456789",
				external_chat_name: null,
				external_chat_type: "private",
			}),
		).toBe("Private chat · 123456789");
	});

	test("labels anonymous group and unknown chat types without hiding their ids", () => {
		expect(
			pairedChatTitle({
				external_chat_id: "-100987654321",
				external_chat_name: null,
				external_chat_type: "supergroup",
			}),
		).toBe("Group chat · -100987654321");
		expect(
			pairedChatTitle({
				external_chat_id: "thread-abc",
				external_chat_name: null,
				external_chat_type: null,
			}),
		).toBe("Chat · thread-abc");
	});

	test("distinguishes Discord server and direct-message bindings", () => {
		const server = {
			external_chat_id: "guild-123",
			external_chat_name: "guild-123",
			external_chat_type: "guild_text",
		};
		const directMessage = {
			external_chat_id: "dm-456",
			external_chat_name: null,
			external_chat_type: "dm",
		};

		expect(pairedChatScopeLabel("discord", server)).toBe("server");
		expect(pairedChatTitle(server, "discord")).toBe("Server · guild-123");
		expect(pairedChatScopeLabel("discord", directMessage)).toBe("direct message");
		expect(pairedChatTitle(directMessage, "discord")).toBe("Direct message · dm-456");
	});
});
