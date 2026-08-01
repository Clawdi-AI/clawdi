import { describe, expect, test } from "bun:test";
import {
	agentProviderHasSingleLinkLimit,
	availableBotProvidersForAgent,
	channelProviderLinkingReady,
	pairCodeExpired,
	pairingActionLabel,
	pairingCommand,
	verifiedDiscordPairingCommand,
} from "./channel-linking.logic";

describe("hosted channel instructions and gates", () => {
	test("renders the exact command accepted by the channel backend", () => {
		expect(pairingCommand("PAIRABC123")).toBe("/bot_pair PAIRABC123");
	});

	test("uses one discoverable Discord server pairing action", () => {
		expect(pairingActionLabel("discord")).toBe("Pair Discord");
		expect(pairingActionLabel("imessage")).toBe("Pair chat");
	});

	test("accepts only the current authoritative Discord pairing command", () => {
		expect(verifiedDiscordPairingCommand("/clawdi_pair PAIRABC123", "PAIRABC123")).toBe(
			"/clawdi_pair PAIRABC123",
		);
		expect(verifiedDiscordPairingCommand("/bot_pair PAIRABC123", "PAIRABC123")).toBeNull();
		expect(verifiedDiscordPairingCommand("/clawdi_pair OTHER", "PAIRABC123")).toBeNull();
		expect(verifiedDiscordPairingCommand(" /clawdi_pair PAIRABC123", "PAIRABC123")).toBeNull();
	});

	test("selects the first unlinked provider and exposes no form when both are linked", () => {
		expect(availableBotProvidersForAgent("agent-1", "openclaw", new Set())).toEqual([
			"telegram",
			"discord",
		]);
		expect(availableBotProvidersForAgent("agent-1", "openclaw", new Set(["telegram"]))).toEqual([
			"discord",
		]);
		expect(
			availableBotProvidersForAgent("agent-1", "openclaw", new Set(["telegram", "discord"])),
		).toEqual([]);
		expect(
			availableBotProvidersForAgent(undefined, undefined, new Set(["telegram", "discord"])),
		).toEqual(["telegram", "discord"]);
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
	});
});
