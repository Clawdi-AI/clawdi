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

	test("keeps legacy iMessage accounts renderable as unavailable", () => {
		expect(providerMeta("imessage")).toMatchObject({
			id: "imessage",
			label: "iMessage (unavailable)",
			unavailable: true,
		});
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
