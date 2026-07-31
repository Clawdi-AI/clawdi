import { describe, expect, test } from "bun:test";
import {
	channelActivityAfterLink,
	channelProviderLinkingReady,
	pairCodeExpired,
	pairingCommand,
} from "./channel-linking.logic";

describe("hosted channel instructions and gates", () => {
	test("renders the exact command accepted by the channel backend", () => {
		expect(pairingCommand("PAIRABC123")).toBe("/bot_pair PAIRABC123");
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

	test("only treats real account activity after linking as new channel activity", () => {
		expect(channelActivityAfterLink(null, "2026-07-26T09:00:00Z")).toBe(false);
		expect(channelActivityAfterLink("2026-07-26T08:59:59Z", "2026-07-26T09:00:00Z")).toBe(false);
		expect(channelActivityAfterLink("2026-07-26T09:00:01Z", "2026-07-26T09:00:00Z")).toBe(true);
		expect(channelActivityAfterLink("not-a-date", "2026-07-26T09:00:00Z")).toBe(false);
	});
});
