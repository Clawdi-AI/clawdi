import { describe, expect, test } from "bun:test";
import type { ChannelBotPoolItem } from "./channel-types";
import {
	dedupeBotPoolProviders,
	orderedChannelsForFilter,
	orderedPoolItemsForFilter,
	providerCounts,
} from "./channels-page.logic";

function poolItem(id: string, provider: string): ChannelBotPoolItem {
	return {
		id,
		provider,
		name: id,
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://example.test/webhook",
		created_at: "2026-01-01T00:00:00Z",
		access: "owner",
		capabilities: {
			link_agent: true,
			pair_chat: true,
			send_message: true,
			manage_account: true,
			sync_commands: true,
		},
		link_count: 0,
		available: true,
	};
}

describe("channel list deduplication", () => {
	test("removes a pool bot already returned by the owned channel list", () => {
		const channels = [{ id: "channel-1", provider: "telegram" }];
		const providers = {
			telegram: [
				poolItem("channel-1", "telegram"),
				poolItem("shared-2", "telegram"),
				poolItem("shared-2", "telegram"),
			],
			discord: [poolItem("shared-3", "discord")],
		};

		const deduped = dedupeBotPoolProviders(channels, providers);

		expect(deduped.telegram?.map((item) => item.id)).toEqual(["shared-2"]);
		expect(providerCounts(channels, deduped)).toEqual({
			telegram: 2,
			discord: 1,
			whatsapp: 0,
		});
	});
});

describe("flat channel sections", () => {
	test("keeps canonical provider order and stable order within each provider", () => {
		const channels = [
			{ id: "discord-1", provider: "discord" },
			{ id: "telegram-1", provider: "telegram" },
			{ id: "discord-2", provider: "discord" },
			{ id: "legacy-1", provider: "imessage" },
			{ id: "telegram-2", provider: "telegram" },
			{ id: "whatsapp-1", provider: "whatsapp" },
		];

		expect(orderedChannelsForFilter(channels, "all").map((item) => item.id)).toEqual([
			"telegram-1",
			"telegram-2",
			"discord-1",
			"discord-2",
			"whatsapp-1",
			"legacy-1",
		]);
		expect(orderedChannelsForFilter(channels, "discord").map((item) => item.id)).toEqual([
			"discord-1",
			"discord-2",
		]);
	});

	test("flattens ready bots without provider subgroups and keeps filter counts exact", () => {
		const providers = {
			discord: [poolItem("discord-1", "discord"), poolItem("discord-2", "discord")],
			telegram: [poolItem("telegram-1", "telegram")],
			imessage: [poolItem("legacy-1", "imessage")],
		};

		expect(orderedPoolItemsForFilter(providers, "all").map((item) => item.id)).toEqual([
			"telegram-1",
			"discord-1",
			"discord-2",
			"legacy-1",
		]);
		expect(orderedPoolItemsForFilter(providers, "telegram")).toHaveLength(1);
		expect(orderedPoolItemsForFilter(providers, "whatsapp")).toEqual([]);
	});
});
