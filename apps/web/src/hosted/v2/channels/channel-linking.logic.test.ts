import { describe, expect, test } from "bun:test";
import {
	agentProviderHasSingleLinkLimit,
	agentProviderLinkLimitDescription,
	channelActivityAfterLink,
	channelProviderLinkingReady,
	discordPairingShouldSyncCommands,
	pairCodeExpired,
	pairingActionLabel,
	pairingCommand,
	prepareProviderPairing,
} from "./channel-linking.logic";

describe("hosted channel instructions and gates", () => {
	test("renders the exact command accepted by the channel backend", () => {
		expect(pairingCommand("PAIRABC123")).toBe("/bot_pair PAIRABC123");
	});

	test("uses one discoverable Discord pairing action for servers and direct messages", () => {
		expect(pairingActionLabel("discord")).toBe("Pair Discord");
		expect(pairingActionLabel("imessage")).toBe("Pair chat");
	});

	test("syncs commands only for user-owned private Discord bots", () => {
		expect(discordPairingShouldSyncCommands("private")).toBe(true);
		expect(discordPairingShouldSyncCommands("public")).toBe(false);
		expect(discordPairingShouldSyncCommands(undefined)).toBe(false);
	});

	test("syncs Discord commands before creating a pair code and stops on sync failure", async () => {
		const events: string[] = [];
		const result = await prepareProviderPairing({
			provider: "discord",
			syncCommands: async () => {
				events.push("sync commands");
			},
			createPairCode: async () => {
				events.push("create pair code");
				return "PAIRABC123";
			},
		});
		expect(result).toBe("PAIRABC123");
		expect(events).toEqual(["sync commands", "create pair code"]);

		let pairCodeCreated = false;
		await expect(
			prepareProviderPairing({
				provider: "discord",
				syncCommands: async () => {
					throw new Error("sync failed");
				},
				createPairCode: async () => {
					pairCodeCreated = true;
				},
			}),
		).rejects.toThrow("sync failed");
		expect(pairCodeCreated).toBe(false);
	});

	test("lets public Discord bots use centrally managed commands without owner-only sync", async () => {
		const events: string[] = [];
		const result = await prepareProviderPairing({
			provider: "discord",
			createPairCode: async () => {
				events.push("create pair code");
				return "PUBLICPAIR123";
			},
		});

		expect(result).toBe("PUBLICPAIR123");
		expect(events).toEqual(["create pair code"]);
	});

	test("does not alter non-Discord pairing with command sync", async () => {
		let syncCalled = false;
		await prepareProviderPairing({
			provider: "telegram",
			syncCommands: async () => {
				syncCalled = true;
			},
			createPairCode: async () => "telegram-code",
		});
		expect(syncCalled).toBe(false);
	});

	test("expires pairing actions exactly at the server deadline", () => {
		const deadline = "2026-07-30T12:00:00Z";
		expect(pairCodeExpired(deadline, Date.parse("2026-07-30T11:59:59Z"))).toBe(false);
		expect(pairCodeExpired(deadline, Date.parse(deadline))).toBe(true);
		expect(pairCodeExpired(deadline, Date.parse("2026-07-30T12:00:01Z"))).toBe(true);
		expect(pairCodeExpired("not-a-timestamp", Date.parse(deadline))).toBe(true);
	});

	test("keeps unavailable providers out of direct Agent linking", () => {
		expect(channelProviderLinkingReady("telegram")).toBe(true);
		expect(channelProviderLinkingReady("discord")).toBe(true);
		expect(channelProviderLinkingReady("whatsapp")).toBe(false);
	});

	test("describes the single-account runtime capability for both hosted runtimes", () => {
		for (const agentType of ["openclaw", "hermes"]) {
			expect(agentProviderHasSingleLinkLimit(agentType, "telegram")).toBe(true);
			expect(agentProviderHasSingleLinkLimit(agentType, "discord")).toBe(true);
		}
		expect(agentProviderHasSingleLinkLimit("openclaw", "whatsapp")).toBe(false);
		expect(agentProviderHasSingleLinkLimit("codex", "telegram")).toBe(false);
		expect(agentProviderLinkLimitDescription("telegram")).toBe(
			"This Agent already has a Telegram bot. Unlink it before connecting another.",
		);
		expect(agentProviderLinkLimitDescription("discord")).toBe(
			"This Agent already has a Discord bot. Unlink it before connecting another.",
		);
	});

	test("only treats real account activity after linking as new channel activity", () => {
		expect(channelActivityAfterLink(null, "2026-07-26T09:00:00Z")).toBe(false);
		expect(channelActivityAfterLink("2026-07-26T08:59:59Z", "2026-07-26T09:00:00Z")).toBe(false);
		expect(channelActivityAfterLink("2026-07-26T09:00:01Z", "2026-07-26T09:00:00Z")).toBe(true);
		expect(channelActivityAfterLink("not-a-date", "2026-07-26T09:00:00Z")).toBe(false);
	});
});
