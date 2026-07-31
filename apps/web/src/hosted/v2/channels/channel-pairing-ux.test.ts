import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const detail = source("./channel-detail-page.tsx");
const pairDialog = source("./telegram-pair-dialog.tsx");
const hooks = source("./channels-hooks.ts");
const connectDialog = source("./connect-bot-dialog.tsx");
const agentDetail = source("../../agents/hosted-agent-detail.tsx");
const pairedChatRow = source("./paired-chat-row.tsx");
const pairedChatRowLogic = source("./paired-chat-row.logic.ts");
const confirmAction = source("../../../components/ui/confirm-action.tsx");
const agentBindingLogic = source("./agent-channel-bindings.logic.ts");

describe("channel IA boundary", () => {
	test("keeps bot detail read-only for Agent relationships and navigates to Agent Channels", () => {
		expect(detail).toContain("data-channel-linked-agents");
		expect(detail).toContain('agentSectionLink(link.agent_id, "channels")');
		expect(detail).toContain("data-channel-agent-link-id={link.id}");
		expect(detail).toContain("Linked Agents");
		expect(detail).not.toContain("LinkAgentDialog");
		expect(detail).not.toContain("TelegramPairDialog");
		expect(detail).not.toContain("PairedChatRow");
		expect(detail).not.toContain("BindingsTab");
		expect(detail).not.toContain("WhatsAppDevicesTab");
		expect(detail).not.toContain("Pair Telegram");
		expect(detail).not.toContain("Unpair");
		expect(detail).not.toContain("Unlink");
		expect(detail).not.toContain("Link an agent");
	});

	test("keeps Link, Pair, Unpair, and Unlink on Agent Channels", () => {
		expect(agentDetail).toContain("data-agent-connected-channels");
		expect(agentDetail).toContain("data-agent-channel-group-id={link.id}");
		expect(agentDetail).toContain("data-agent-channel-chats-for={link.id}");
		expect(agentDetail).not.toContain("data-agent-paired-chats");
		expect(agentDetail).toContain("data-agent-add-channel");
		expect(agentDetail).toContain("Pair Telegram");
		expect(agentDetail).toContain("Pair chat");
		expect(agentDetail).toContain('confirmLabel="Unlink"');
		expect(agentDetail).toContain("<PairedChatRow");
		expect(pairedChatRow).toContain("Unpair");
		expect(agentDetail).toContain("body: { agent_id: environmentId }");
		expect(agentDetail).toContain("agentProviderHasSingleLinkLimit");
		expect(agentDetail).toContain("linkedProviders={linkedProviders}");
		expect(connectDialog).toContain("Already linked");
		expect(connectDialog).toContain("agentProviderLinkLimitDescription");
		expect(agentDetail).toContain('<details className="group border-t pt-4">');
	});

	test("opens the shared fixed-TTL Telegram flow immediately after a new link", () => {
		expect(agentDetail).toContain("const [telegramPair, setTelegramPair]");
		expect(agentDetail).toContain('account?.provider === "telegram"');
		expect(agentDetail).toContain("onAgentConnected={(bot)");
		expect(agentDetail).toContain("<TelegramPairDialog");
		expect(pairDialog).toContain("const TELEGRAM_PAIR_TTL_SECONDS = 900");
		expect(pairDialog).toContain("agent_link_id: agentLinkId");
		expect(pairDialog).toContain("ttl_seconds: TELEGRAM_PAIR_TTL_SECONDS");
		expect(pairDialog).toContain("openKeyRef.current === openKey");
		expect(pairDialog).not.toContain("Select");
	});

	test("makes the validated server deep link and QR primary with manual group recovery", () => {
		expect(pairDialog).toContain("value={validLink}");
		expect(pairDialog).toContain("href={validLink}");
		expect(pairDialog).toContain("qrPayload: result.qr_payload");
		expect(pairDialog).toContain('aria-label="Telegram pairing QR code"');
		expect(pairDialog).toContain('"Copy link"');
		expect(pairDialog).toContain("Telegram link unavailable");
		expect(pairDialog).toContain("This Telegram link has expired");
		expect(pairDialog).toContain("Pair a group manually");
		expect(pairDialog).toContain('title="Couldn\'t create Telegram link"');
	});

	test("shows chat identity and isolates Unpair to the selected chat with recovery", () => {
		expect(agentDetail).toContain("useChannelBindingsForAccounts(activeAccountIds)");
		expect(agentDetail).toContain("selectAgentPairedChats");
		expect(agentDetail).toContain("pairedChatsByLinkId.get(link.id) ?? []");
		expect(pairedChatRow).toContain("Only this chat will be disconnected");
		expect(pairedChatRow).toContain("unpair.mutateAsync(binding.id)");
		expect(pairedChatRow).toContain("unpair.isPending");
		expect(confirmAction).toContain("void runConfirm().catch");
		expect(hooks).toContain("export function useDeleteChannelBinding");
		expect(hooks).toContain("keys.bindings(accountId)");
		expect(hooks).toContain('toastApiError("Couldn\'t unpair chat")');
		expect(hooks).toContain("refetchInterval: 3_000");
	});

	test("renders chats below channels without duplicating provider identity", () => {
		expect(pairedChatRow).toContain("<IconChip");
		expect(pairedChatRow).toContain("<MessageCircle");
		expect(pairedChatRow).toContain("<MessagesSquare");
		expect(pairedChatRow).toContain("pairedChatTitle(binding)");
		expect(pairedChatRowLogic).toContain("external_chat_name?.trim()");
		expect(pairedChatRowLogic).toContain("binding.external_chat_id");
		expect(pairedChatRow).not.toContain("<ProviderChip");
		expect(pairedChatRow).not.toContain("CopyInline");
		expect(pairedChatRow).not.toContain("Paired to");
		expect(pairedChatRow).not.toContain("Through");
	});

	test("filters Agent-page chats by the visible active link and account", () => {
		expect(agentBindingLogic).toContain("activeAgentChannelLinks(visibleLinks)");
		expect(agentBindingLogic).toContain("binding.account_id !== accountId");
		expect(agentBindingLogic).toContain("linksById.get(binding.agent_link_id)");
		expect(agentBindingLogic).toContain("link.account_id !== accountId");
	});

	test("never renders returned runtime credentials", () => {
		for (const ui of [detail, pairDialog, connectDialog, agentDetail]) {
			expect(ui).not.toContain("TokenReveal");
			expect(ui).not.toContain("agent_token");
			expect(ui).not.toContain("Agent token");
			expect(ui).not.toContain("one-time-secret-value");
		}
	});
});
