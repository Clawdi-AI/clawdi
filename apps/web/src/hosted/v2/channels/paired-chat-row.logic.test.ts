import { describe, expect, test } from "bun:test";
import { pairedChatTitle } from "@/hosted/v2/channels/paired-chat-row.logic";

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
});
