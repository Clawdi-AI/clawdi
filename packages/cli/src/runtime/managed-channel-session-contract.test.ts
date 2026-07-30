import { describe, expect, test } from "bun:test";

// Fixed upstream contracts are used because this repository does not vendor or
// execute either runtime. Keep these fixtures aligned with the audited sources:
// OpenClaw f4a7f2b553d3fd788552f3f3ae1004ecac8b2370
//   src/config/zod-schema.session.ts, src/routing/session-key.ts
// Hermes 736fc4d86a1acd8c96473aeb55f9c783e2170dca
//   gateway/session.py, gateway/platforms/telegram.py

function openClawDirectSessionKey(channel: string, accountId: string, peerId: string): string {
	return `agent:main:${channel}:${accountId}:direct:${peerId}`;
}

function hermesTelegramThreadId(
	chatType: "dm" | "group",
	messageThreadId: string | undefined,
	isTopicMessage: boolean,
	isForumGroup: boolean,
): string | undefined {
	if (!messageThreadId) return chatType === "group" && isForumGroup ? "1" : undefined;
	if (chatType === "group" && (isTopicMessage || isForumGroup)) {
		return messageThreadId;
	}
	if (chatType === "dm" && isTopicMessage) return messageThreadId;
	return undefined;
}

function hermesTelegramSessionKey(
	chatType: "dm" | "group",
	chatId: string,
	threadId?: string,
): string {
	return ["agent:main", "telegram", chatType, chatId, threadId].filter(Boolean).join(":");
}

describe("managed Telegram upstream session contracts", () => {
	test("OpenClaw includes account, channel, and peer in every managed DM identity", () => {
		const first = openClawDirectSessionKey("telegram", "managed-a", "chat-101");
		const secondChat = openClawDirectSessionKey("telegram", "managed-a", "chat-202");
		const secondAccount = openClawDirectSessionKey("telegram", "managed-b", "chat-101");
		const secondChannel = openClawDirectSessionKey("discord", "managed-a", "chat-101");

		expect(first).toBe("agent:main:telegram:managed-a:direct:chat-101");
		expect(new Set([first, secondChat, secondAccount, secondChannel]).size).toBe(4);
	});

	test("Hermes isolates DMs by native chat_id and groups by chat", () => {
		const dmA = hermesTelegramSessionKey("dm", "101");
		const dmB = hermesTelegramSessionKey("dm", "202");
		// group_sessions_per_user=false means both participants use this chat key.
		const groupUserA = hermesTelegramSessionKey("group", "-1001");
		const groupUserB = hermesTelegramSessionKey("group", "-1001");

		expect(dmA).not.toBe(dmB);
		expect(groupUserA).toBe(groupUserB);
		expect(groupUserA).toBe("agent:main:telegram:group:-1001");
	});

	test("Hermes keeps true forum topics distinct and ignores ordinary reply threads", () => {
		const forumThread = hermesTelegramThreadId("group", "77", true, true);
		const anotherForumThread = hermesTelegramThreadId("group", "88", true, true);
		const ordinaryReplyThread = hermesTelegramThreadId("group", "999", false, false);

		expect(hermesTelegramSessionKey("group", "-1001", forumThread)).not.toBe(
			hermesTelegramSessionKey("group", "-1001", anotherForumThread),
		);
		expect(ordinaryReplyThread).toBeUndefined();
		expect(hermesTelegramSessionKey("group", "-1001", ordinaryReplyThread)).toBe(
			"agent:main:telegram:group:-1001",
		);
	});
});
