import { describe, expect, test } from "bun:test";
import {
	linkAgentBlockReason,
	shouldMintWhatsappTenantCredential,
	WHATSAPP_COMING_SOON_MESSAGE,
} from "./link-agent-dialog.logic";

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
		).toContain("one-telegram-link-per-Hermes-agent");
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
