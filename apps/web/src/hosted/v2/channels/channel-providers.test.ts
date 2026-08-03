import { describe, expect, test } from "bun:test";
import {
	CHANNEL_PROVIDERS,
	isChannelProvider,
	orderedProviderIds,
	providerMeta,
} from "./channel-providers";

describe("channel provider registry", () => {
	test("only exposes providers that can be created from the v2 channels UI", () => {
		expect(CHANNEL_PROVIDERS).toEqual(["telegram", "discord", "whatsapp"]);
		expect(isChannelProvider("imessage")).toBe(false);
	});

	test("does not retain provider-specific metadata for retired accounts", () => {
		expect(providerMeta("imessage")).toMatchObject({
			id: "imessage",
			label: "imessage",
			unavailable: true,
		});
	});

	test("provides only the official setup links used by the compact connect form", () => {
		expect(providerMeta("telegram").setupUrl).toBe("https://t.me/BotFather");
		expect(providerMeta("discord").setupUrl).toBe("https://discord.com/developers/applications");
	});

	test("orders supported providers first and appends legacy providers from data", () => {
		expect(orderedProviderIds(["imessage", "discord", "telegram", "custom", "telegram"])).toEqual([
			"telegram",
			"discord",
			"imessage",
			"custom",
		]);
	});
});
