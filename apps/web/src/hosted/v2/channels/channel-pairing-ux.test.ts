import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const detail = source("./channel-detail-page.tsx");
const hooks = source("./channels-hooks.ts");
const linkDialog = source("./link-agent-dialog.tsx");
const connectDialog = source("./connect-bot-dialog.tsx");
const agentDetail = source("../../agents/hosted-agent-detail.tsx");

describe("Telegram channel pairing UX", () => {
	test("keeps Link Agent, Pair Telegram, and paired chats in one visible card flow", () => {
		const linkStep = detail.indexOf('title="Link Agent"');
		const pairStep = detail.indexOf('title={ch.provider === "telegram" ? "Pair Telegram"');
		const pairedChats = detail.indexOf('label="Paired chats"', pairStep);

		expect(detail).toContain("data-channel-setup-flow");
		expect(detail).toContain("data-channel-setup-step={step}");
		expect(linkStep).toBeGreaterThanOrEqual(0);
		expect(pairStep).toBeGreaterThan(linkStep);
		expect(pairedChats).toBeGreaterThan(pairStep);
		expect(detail).not.toContain('<TabsTrigger value="agents">');
		expect(detail).not.toContain('<TabsTrigger value="pair">');
		expect(detail).not.toContain('<TabsTrigger value="bindings">');
	});

	test("makes the validated server deep link and QR primary with compact fallback", () => {
		expect(detail).toContain("value={validTelegramLink}");
		expect(detail).toContain("href={validTelegramLink}");
		expect(detail).toContain("qrPayload: result.qr_payload");
		expect(detail).toContain('aria-label="Telegram pairing QR code"');
		expect(detail).toContain("`Open @${result.bot_username");
		expect(detail).toContain("Telegram link unavailable");
		expect(detail).toContain("returns a valid t.me start link");
		expect(detail).toContain("pairCodeExpiryLabel(result.expires_at, nowMs)");
		expect(detail).toContain("Manual command");
		expect(detail).not.toContain("QRCodeSVG value={result.qr_payload}");
		expect(detail).not.toContain("href={result.deep_link}");
	});

	test("keeps the Agent Channels entry point on the same server-link contract", () => {
		expect(agentDetail).toContain("telegramPairDeepLink({");
		expect(agentDetail).toContain("value={validTelegramLink}");
		expect(agentDetail).toContain("qrPayload: code.qr_payload");
		expect(agentDetail).toContain("href={validTelegramLink}");
		expect(agentDetail).toContain("Pair a group manually");
		expect(agentDetail).toContain("pairCodeExpiryLabel(code.expires_at, nowMs)");
		expect(agentDetail).toContain("await pair.execute({ agent_link_id: link.id })");
		expect(agentDetail).not.toContain("href={code.deep_link}");
		expect(agentDetail).not.toContain("pairingCommand(code.code)");
	});

	test("requires an existing AgentLink before Pair code creation", () => {
		expect(detail).toContain("const linkedAgents = links.data ?? []");
		expect(detail).toContain("agent_link_id: selectedLink.id");
		expect(detail).toContain("Link an Agent above before creating a pairing link.");
		expect(detail).not.toContain("agent_id: selectedAgent");
		expect(hooks).toContain("vars: { agent_link_id: string; ttl_seconds?: number }");
	});

	test("shows Agent identity and isolates Unpair to the selected chat with recovery", () => {
		expect(detail).toContain("binding.agent_link_id");
		expect(detail).toContain("<AgentName");
		expect(detail).toContain("Only this chat will be disconnected");
		expect(detail).toContain("await unpair.mutateAsync(bindingId)");
		expect(detail).toContain("finally");
		expect(hooks).toContain("export function useDeleteChannelBinding");
		expect(hooks).toContain("keys.bindings(accountId)");
		expect(hooks).toContain('toastApiError("Couldn\'t unpair chat")');
		expect(hooks).toContain("refetchInterval: 3_000");
	});

	test("never renders returned runtime credentials in Link or Pair surfaces", () => {
		for (const ui of [detail, linkDialog, connectDialog, agentDetail]) {
			expect(ui).not.toContain("TokenReveal");
			expect(ui).not.toContain("agent_token");
			expect(ui).not.toContain("Agent token");
			expect(ui).not.toContain("one-time-secret-value");
		}
	});
});
