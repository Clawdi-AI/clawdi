import { describe, expect, test } from "bun:test";
import {
	channelActivityAfterLink,
	channelProviderLinkingReady,
	linkAgentBlockReason,
	pairCodeExpired,
	pairingCommand,
	shouldMintWhatsappTenantCredential,
	WHATSAPP_COMING_SOON_MESSAGE,
} from "./link-agent-dialog.logic";

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

	test("keeps unavailable providers out of direct agent linking", () => {
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

describe("linkAgentBlockReason", () => {
	test("blocks WhatsApp for all selected runtime agents", () => {
		expect(
			linkAgentBlockReason({
				provider: "whatsapp",
				selectedAgent: { agent_type: "hermes" },
				existingAgentLinks: [],
				accountId: "wa-current",
			}),
		).toBe(WHATSAPP_COMING_SOON_MESSAGE);
		expect(
			linkAgentBlockReason({
				provider: "whatsapp",
				selectedAgent: { agent_type: "openclaw" },
				existingAgentLinks: [],
				accountId: "wa-current",
			}),
		).toBe(WHATSAPP_COMING_SOON_MESSAGE);
	});

	test("blocks a second Telegram or Discord link for Hermes agents", () => {
		expect(
			linkAgentBlockReason({
				provider: "telegram",
				selectedAgent: { agent_type: "hermes" },
				existingAgentLinks: [
					{
						account_id: "tg-existing",
						status: "active",
						account: { provider: "telegram" },
					},
				],
				accountId: "tg-current",
			}),
		).toBe(
			"Hermes agents can use one active Telegram bot at a time. Unlink the current Telegram bot before linking another.",
		);
	});

	test("allows the current existing link and non-Hermes multi-link behavior", () => {
		expect(
			linkAgentBlockReason({
				provider: "telegram",
				selectedAgent: { agent_type: "hermes" },
				existingAgentLinks: [
					{
						account_id: "tg-current",
						status: "active",
						account: { provider: "telegram" },
					},
				],
				accountId: "tg-current",
			}),
		).toBeNull();
		expect(
			linkAgentBlockReason({
				provider: "telegram",
				selectedAgent: { agent_type: "openclaw" },
				existingAgentLinks: [
					{
						account_id: "tg-existing",
						status: "active",
						account: { provider: "telegram" },
					},
				],
				accountId: "tg-current",
			}),
		).toBeNull();
	});
});

describe("shouldMintWhatsappTenantCredential", () => {
	test("does not mint WhatsApp credentials while linking is gated", () => {
		expect(shouldMintWhatsappTenantCredential("whatsapp", { agent_type: "openclaw" })).toBe(false);
		expect(shouldMintWhatsappTenantCredential("whatsapp", { agent_type: "hermes" })).toBe(false);
		expect(shouldMintWhatsappTenantCredential("whatsapp", { agent_type: "claude_code" })).toBe(
			false,
		);
		expect(shouldMintWhatsappTenantCredential("telegram", { agent_type: "openclaw" })).toBe(false);
	});
});
