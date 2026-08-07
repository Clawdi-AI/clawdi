import { describe, expect, test } from "bun:test";
import type { ChannelBotPoolItem } from "./channel-types";
import {
	orderedChannelsForFilter,
	providerCounts,
	providersWithBots,
	sharedBotsFromPool,
} from "./channels-page.logic";

function poolBot(
	id: string,
	provider: string,
	access: ChannelBotPoolItem["access"],
): ChannelBotPoolItem {
	return {
		id,
		provider,
		name: id,
		status: "active",
		visibility: access === "public" ? "public" : "private",
		has_provider_token: true,
		webhook_url: `https://example.test/${id}`,
		created_at: "2026-07-31T00:00:00Z",
		access,
		capabilities: {
			link_agent: access === "public",
			pair_chat: false,
			send_message: false,
			manage_account: access === "owner",
			sync_commands: false,
		},
		link_count: 0,
		available: true,
	};
}

describe("owned bot inventory", () => {
	test("keeps canonical provider order and stable order within each provider", () => {
		const channels = [
			{ id: "discord-1", provider: "discord" },
			{ id: "telegram-1", provider: "telegram" },
			{ id: "discord-2", provider: "discord" },
			{ id: "custom-1", provider: "custom" },
			{ id: "telegram-2", provider: "telegram" },
			{ id: "whatsapp-1", provider: "whatsapp" },
		];

		expect(orderedChannelsForFilter(channels, "all").map((item) => item.id)).toEqual([
			"telegram-1",
			"telegram-2",
			"discord-1",
			"discord-2",
			"whatsapp-1",
			"custom-1",
		]);
		expect(orderedChannelsForFilter(channels, "discord").map((item) => item.id)).toEqual([
			"discord-1",
			"discord-2",
		]);
	});

	test("counts only owned bots for global filters", () => {
		const counts = providerCounts([
			{ provider: "telegram" },
			{ provider: "telegram" },
			{ provider: "discord" },
			{ provider: "custom" },
		]);

		expect(counts).toEqual({ telegram: 2, discord: 1, whatsapp: 0 });
		expect(providersWithBots(counts)).toEqual(["telegram", "discord"]);
	});

	test("keeps an existing WhatsApp asset discoverable without showing empty providers", () => {
		expect(providersWithBots({ telegram: 0, discord: 0, whatsapp: 1 })).toEqual(["whatsapp"]);
	});

	test("keeps public shared bots visible independently from owned inventory", () => {
		const sharedDiscord = poolBot("shared-discord", "discord", "public");
		const privateDiscord = poolBot("private-discord", "discord", "owner");
		const sharedTelegram = poolBot("shared-telegram", "telegram", "public");
		expect(
			sharedBotsFromPool({
				discord: [sharedDiscord, privateDiscord],
				telegram: [sharedTelegram],
			}),
		).toEqual([sharedTelegram, sharedDiscord]);
	});
});
