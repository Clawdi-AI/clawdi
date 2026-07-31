import { describe, expect, test } from "bun:test";
import { orderedChannelsForFilter, providerCounts } from "./channels-page.logic";

describe("owned bot inventory", () => {
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

	test("counts only owned bots for global filters", () => {
		expect(
			providerCounts([
				{ provider: "telegram" },
				{ provider: "telegram" },
				{ provider: "discord" },
				{ provider: "imessage" },
			]),
		).toEqual({ telegram: 2, discord: 1, whatsapp: 0 });
	});
});
