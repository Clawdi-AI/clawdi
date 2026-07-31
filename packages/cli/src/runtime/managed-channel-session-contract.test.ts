import { describe, expect, test } from "bun:test";

// Fixed upstream contracts are used because this repository does not vendor or
// execute either runtime. Keep these fixtures aligned with the audited sources:
// OpenClaw npm 2026.7.1-2 (0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c)
//   src/config/zod-schema.session.ts::SessionSchema
//   src/routing/session-key.ts::buildAgentPeerSessionKey
// Hermes 0.19.1 main (f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1)
//   gateway/session.py::build_session_key
//   gateway/platforms/telegram.py::TelegramAdapter._build_message_event

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
	source: {
		chatType: "dm" | "group";
		chatId?: string;
		userId?: string;
		threadId?: string;
	},
	settings: {
		groupSessionsPerUser: boolean;
		threadSessionsPerUser: boolean;
	} = { groupSessionsPerUser: true, threadSessionsPerUser: false },
): string {
	if (source.chatType === "dm") {
		if (source.chatId) {
			return ["agent:main", "telegram", "dm", source.chatId, source.threadId]
				.filter(Boolean)
				.join(":");
		}
		return ["agent:main", "telegram", "dm", source.threadId].filter(Boolean).join(":");
	}

	const keyParts = ["agent:main", "telegram", source.chatType];
	if (source.chatId) keyParts.push(source.chatId);
	if (source.threadId) keyParts.push(source.threadId);
	let isolateUser = settings.groupSessionsPerUser;
	if (source.threadId && !settings.threadSessionsPerUser) isolateUser = false;
	if (isolateUser && source.userId) keyParts.push(source.userId);
	return keyParts.join(":");
}

describe("managed Telegram upstream session contracts", () => {
	const managedHermesSettings = {
		groupSessionsPerUser: false,
		threadSessionsPerUser: false,
	};

	test("OpenClaw includes account, channel, and peer in every managed DM identity", () => {
		const first = openClawDirectSessionKey("telegram", "managed-a", "chat-101");
		const secondChat = openClawDirectSessionKey("telegram", "managed-a", "chat-202");
		const secondAccount = openClawDirectSessionKey("telegram", "managed-b", "chat-101");
		const secondChannel = openClawDirectSessionKey("discord", "managed-a", "chat-101");

		expect(first).toBe("agent:main:telegram:managed-a:direct:chat-101");
		expect(new Set([first, secondChat, secondAccount, secondChannel]).size).toBe(4);
	});

	test("Hermes isolates DMs by native chat_id and groups by chat", () => {
		const dmA = hermesTelegramSessionKey({ chatType: "dm", chatId: "101", userId: "user-a" });
		const dmB = hermesTelegramSessionKey({ chatType: "dm", chatId: "202", userId: "user-b" });
		const groupUserA = hermesTelegramSessionKey(
			{ chatType: "group", chatId: "-1001", userId: "user-a" },
			managedHermesSettings,
		);
		const groupUserB = hermesTelegramSessionKey(
			{ chatType: "group", chatId: "-1001", userId: "user-b" },
			managedHermesSettings,
		);

		expect(dmA).not.toBe(dmB);
		expect(groupUserA).toBe(groupUserB);
		expect(groupUserA).toBe("agent:main:telegram:group:-1001");
		expect(
			hermesTelegramSessionKey({ chatType: "group", chatId: "-1001", userId: "user-a" }),
		).not.toBe(hermesTelegramSessionKey({ chatType: "group", chatId: "-1001", userId: "user-b" }));
	});

	test("Hermes keeps true forum topics distinct and ignores ordinary reply threads", () => {
		const forumThread = hermesTelegramThreadId("group", "77", true, true);
		const anotherForumThread = hermesTelegramThreadId("group", "88", true, true);
		const ordinaryReplyThread = hermesTelegramThreadId("group", "999", false, false);
		const forumUserA = hermesTelegramSessionKey(
			{ chatType: "group", chatId: "-1001", userId: "user-a", threadId: forumThread },
			managedHermesSettings,
		);
		const forumUserB = hermesTelegramSessionKey(
			{ chatType: "group", chatId: "-1001", userId: "user-b", threadId: forumThread },
			managedHermesSettings,
		);

		expect(forumUserA).toBe(forumUserB);
		expect(forumUserA).not.toBe(
			hermesTelegramSessionKey(
				{
					chatType: "group",
					chatId: "-1001",
					userId: "user-b",
					threadId: anotherForumThread,
				},
				managedHermesSettings,
			),
		);
		expect(ordinaryReplyThread).toBeUndefined();
		expect(
			hermesTelegramSessionKey(
				{
					chatType: "group",
					chatId: "-1001",
					userId: "user-a",
					threadId: ordinaryReplyThread,
				},
				managedHermesSettings,
			),
		).toBe("agent:main:telegram:group:-1001");
		expect(
			hermesTelegramSessionKey({
				chatType: "dm",
				chatId: "101",
				threadId: hermesTelegramThreadId("dm", "77", true, false),
			}),
		).toBe("agent:main:telegram:dm:101:77");
	});
});
