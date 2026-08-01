import { describe, expect, test } from "bun:test";
import {
	agentProviderHasSingleLinkLimit,
	availableBotProvidersForAgent,
	channelProviderLinkingReady,
	pairCodeExpired,
	pairingActionLabel,
	pairingCommand,
	verifiedDiscordPairingCommand,
	verifiedDiscordServerInstallUrl,
	verifiedDiscordUserInstallUrl,
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

	test("accepts only the official Discord User Install authorize contract", () => {
		const supported =
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=1&scope=applications.commands";
		expect(verifiedDiscordUserInstallUrl(supported)).toBe(supported);
		for (const unsupported of [
			null,
			undefined,
			"not-a-url",
			"https://example.com/oauth2/authorize?client_id=123456789012345678&integration_type=1&scope=applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=0&scope=applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=1&scope=bot%20applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=1&scope=applications.commands&permissions=8",
		]) {
			expect(verifiedDiscordUserInstallUrl(unsupported)).toBeNull();
		}
	});

	test("accepts only the explicit Discord Guild Install bot contract", () => {
		const supported =
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=0&permissions=274878024768&scope=bot%20applications.commands";
		expect(verifiedDiscordServerInstallUrl(supported)).toBe(supported);
		for (const unsupported of [
			null,
			undefined,
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&permissions=274878024768&scope=bot%20applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=1&permissions=274878024768&scope=bot%20applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=0&permissions=0&scope=bot%20applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=0&permissions=274878024768&scope=applications.commands",
		]) {
			expect(verifiedDiscordServerInstallUrl(unsupported)).toBeNull();
		}
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
