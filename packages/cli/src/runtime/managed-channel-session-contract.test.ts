import { describe, expect, test } from "bun:test";

// Fixed upstream contracts are used because this repository does not vendor or
// execute either runtime. Keep these fixtures aligned with the audited sources:
// OpenClaw artifact (0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c)
//   src/routing/session-key.ts::buildAgentPeerSessionKey
//   extensions/discord/src/monitor/route-resolution.ts::buildDiscordRoutePeer
// Hermes 0.19.1 (f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1)
//   gateway/session.py::build_session_key
//   plugins/platforms/telegram/adapter.py::TelegramAdapter._build_message_event
//   plugins/platforms/discord/adapter.py (effective_channel.id source routing)

function openClawDirectSessionKey(channel: string, accountId: string, peerId: string): string {
	return `agent:main:${channel}:${accountId}:direct:${peerId}`;
}

function openClawDiscordSessionKey(source: {
	accountId: string;
	conversationId: string;
	directUserId?: string;
}): string {
	return source.directUserId
		? openClawDirectSessionKey("discord", source.accountId, source.directUserId)
		: `agent:main:discord:channel:${source.conversationId}`;
}

function hermesDiscordSessionKey(source: {
	chatType: "dm" | "group" | "thread";
	chatId: string;
	threadId?: string;
}): string {
	return ["agent:main", "discord", source.chatType, source.chatId, source.threadId]
		.filter(Boolean)
		.join(":");
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

describe("managed Discord upstream session contracts", () => {
	test("OpenClaw keys guild channels and threads by their physical conversation ids", () => {
		const channelA = openClawDiscordSessionKey({
			accountId: "managed-discord",
			conversationId: "channel-a",
		});
		const channelB = openClawDiscordSessionKey({
			accountId: "managed-discord",
			conversationId: "channel-b",
		});
		const threadB = openClawDiscordSessionKey({
			accountId: "managed-discord",
			conversationId: "thread-b-1",
		});

		expect(channelA).toBe("agent:main:discord:channel:channel-a");
		expect(new Set([channelA, channelB, threadB]).size).toBe(3);
		for (const key of [channelA, channelB, threadB]) expect(key).not.toContain("guild-1");
	});

	test("Hermes keys guild channels, threads, and DMs by effective Discord channel ids", () => {
		const channelA = hermesDiscordSessionKey({ chatType: "group", chatId: "channel-a" });
		const channelB = hermesDiscordSessionKey({ chatType: "group", chatId: "channel-b" });
		const threadB = hermesDiscordSessionKey({
			chatType: "thread",
			chatId: "thread-b-1",
			threadId: "thread-b-1",
		});
		const dm = hermesDiscordSessionKey({ chatType: "dm", chatId: "dm-channel-1" });

		expect(channelA).toBe("agent:main:discord:group:channel-a");
		expect(threadB).toBe("agent:main:discord:thread:thread-b-1:thread-b-1");
		expect(dm).toBe("agent:main:discord:dm:dm-channel-1");
		expect(new Set([channelA, channelB, threadB, dm]).size).toBe(4);
		for (const key of [channelA, channelB, threadB]) expect(key).not.toContain("guild-1");
	});

	test("OpenClaw keeps managed Discord DMs account- and user-scoped", () => {
		const dmA = openClawDiscordSessionKey({
			accountId: "managed-a",
			conversationId: "dm-channel-a",
			directUserId: "user-a",
		});
		const dmB = openClawDiscordSessionKey({
			accountId: "managed-a",
			conversationId: "dm-channel-b",
			directUserId: "user-b",
		});
		const otherAccount = openClawDiscordSessionKey({
			accountId: "managed-b",
			conversationId: "dm-channel-a",
			directUserId: "user-a",
		});

		expect(dmA).toBe("agent:main:discord:managed-a:direct:user-a");
		expect(new Set([dmA, dmB, otherAccount]).size).toBe(3);
	});
});
