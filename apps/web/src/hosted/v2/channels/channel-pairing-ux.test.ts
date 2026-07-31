import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const detail = source("./channel-detail-page.tsx");
const pairDialog = source("./telegram-pair-dialog.tsx");
const hooks = source("./channels-hooks.ts");
const linkDialog = source("./link-agent-dialog.tsx");
const connectDialog = source("./connect-bot-dialog.tsx");
const agentDetail = source("../../agents/hosted-agent-detail.tsx");

describe("Telegram channel pairing UX", () => {
	test("keeps a full-width, single-layer linked Agent and paired chat layout", () => {
		const linkedAgents = detail.indexOf("<AgentsTab");
		const pairedChats = detail.indexOf('label="Paired chats"');
		expect(detail).toContain("data-channel-setup-flow");
		expect(linkedAgents).toBeGreaterThanOrEqual(0);
		expect(pairedChats).toBeGreaterThan(linkedAgents);
		expect(detail).toContain("CHANNEL_RELATION_LIST_CLASS");
		expect(detail).toContain("CHANNEL_RELATION_ROW_CLASS");
		expect(detail).not.toContain("max-w-3xl");
		expect(detail).not.toContain("SetupStepCard");
		expect(detail).not.toContain("PairCodeTab");
		expect(detail).not.toContain('id="pair-agent"');
		expect(detail).not.toContain('id="pair-ttl"');
		expect(detail).not.toContain("TTL_OPTIONS");
		expect(detail).not.toContain('<TabsTrigger value="agents">');
		expect(detail).not.toContain('<TabsTrigger value="pair">');
		expect(detail).not.toContain('<TabsTrigger value="bindings">');
	});

	test("opens one fixed-TTL dialog from the selected linked Agent row", () => {
		expect(detail).toContain("setPairingLink(link)");
		expect(detail).toContain("Pair Telegram");
		expect(detail).toContain("agentLinkId={pairingLink.id}");
		expect(pairDialog).toContain("const TELEGRAM_PAIR_TTL_SECONDS = 900");
		expect(pairDialog).toContain("agent_link_id: agentLinkId");
		expect(pairDialog).toContain("ttl_seconds: TELEGRAM_PAIR_TTL_SECONDS");
		expect(pairDialog).toContain("openKeyRef.current === openKey");
		expect(pairDialog).not.toContain("Select");
	});

	test("makes the validated server deep link and QR primary with compact actions", () => {
		expect(pairDialog).toContain("value={validLink}");
		expect(pairDialog).toContain("href={validLink}");
		expect(pairDialog).toContain("qrPayload: result.qr_payload");
		expect(pairDialog).toContain('aria-label="Telegram pairing QR code"');
		expect(pairDialog).toContain("`Open @${result.bot_username");
		expect(pairDialog).toContain('"Copy link"');
		expect(pairDialog).toContain("Telegram link unavailable");
		expect(pairDialog).toContain("This Telegram link has expired");
		expect(pairDialog).toContain("pairCodeExpiryLabel(result.expires_at, nowMs)");
		expect(pairDialog).toContain("Pair a group manually");
		expect(pairDialog).not.toContain("QRCodeSVG value={result.qr_payload}");
		expect(pairDialog).not.toContain("href={result.deep_link}");
	});

	test("reuses the same dialog from Agent Channels without a second Telegram QR UI", () => {
		expect(agentDetail).toContain("<TelegramPairDialog");
		expect(agentDetail).toContain("agentLinkId={link.id}");
		expect(agentDetail).toContain("setTelegramPairOpen(true)");
		expect(agentDetail).not.toContain("QRCodeSVG");
		expect(agentDetail).not.toContain("telegramPairDeepLink");
		expect(agentDetail).not.toContain("href={code.deep_link}");
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
		for (const ui of [detail, pairDialog, linkDialog, connectDialog, agentDetail]) {
			expect(ui).not.toContain("TokenReveal");
			expect(ui).not.toContain("agent_token");
			expect(ui).not.toContain("Agent token");
			expect(ui).not.toContain("one-time-secret-value");
		}
	});
});
