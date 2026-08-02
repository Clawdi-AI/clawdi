import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const detail = source("./channel-detail-page.tsx");
const pairDialog = source("./telegram-pair-dialog.tsx");
const discordPairDialog = source("./discord-pair-dialog.tsx");
const pairingDialogUi = source("./pairing-dialog-ui.tsx");
const pairingSuccess = source("./channel-pairing-success.ts");
const hooks = source("./channels-hooks.ts");
const connectDialog = source("./connect-bot-dialog.tsx");
const agentCardsLogic = source("./agent-channel-cards.logic.ts");
const agentDetail = source("../../agents/hosted-agent-detail.tsx");
const pairedChatRow = source("./paired-chat-row.tsx");
const pairedChatRowLogic = source("./paired-chat-row.logic.ts");
const pairedChatsDialog = source("./paired-chats-dialog.tsx");
const confirmAction = source("../../../components/ui/confirm-action.tsx");
const agentBindingLogic = source("./agent-channel-bindings.logic.ts");
const linkedChannelRow = agentDetail.slice(
	agentDetail.indexOf("function LinkedChannelRow"),
	agentDetail.indexOf("// ── Settings / Compute"),
);

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

	test("keeps Link, Pair, Unpair, and Unlink on stable Agent bot cards", () => {
		expect(agentDetail).toContain("data-agent-channels");
		expect(agentDetail).toContain("data-agent-channel-section={kind}");
		expect(agentDetail).toContain("data-agent-channel-account-id={bot.id}");
		expect(agentDetail).toContain("data-agent-channel-group-id={link.id}");
		expect(pairedChatsDialog).toContain("data-agent-channel-chats-for={linkId}");
		expect(agentDetail).not.toContain("data-agent-paired-chats");
		expect(agentDetail).toContain("data-agent-add-custom-bot");
		expect(agentDetail).toContain('linking ? "Linking…" : "Link"');
		expect(agentDetail).toContain('creatingPairCode ? "Generating…" : "Pair"');
		expect(agentDetail).not.toContain("Pair Telegram");
		expect(agentDetail).not.toContain("Pair Discord");
		expect(agentDetail).not.toContain("Retry pairing");
		expect(agentDetail).toContain('confirmLabel="Unlink"');
		expect(agentDetail).toContain("<ConfirmAction");
		expect(agentDetail).toContain("<PairedChatsDialog");
		expect(pairedChatsDialog).toContain("<PairedChatRow");
		expect(pairedChatRow).toContain("Unpair");
		expect(agentDetail).toContain("body: { agent_id: environmentId }");
		expect(agentDetail).toContain("agentProviderHasSingleLinkLimit");
		expect(agentDetail).toContain('title="Clawdi bots"');
		expect(agentDetail).toContain('title="Custom bots"');
		expect(agentDetail).toContain("No Clawdi bots available");
		expect(agentDetail).toContain("No custom bots yet");
		expect(agentDetail).toContain("Add channel");
		expect(agentDetail).not.toContain("<AddChannelDialog");
		expect(agentDetail).toContain("<ConnectBotDialog");
		expect(agentDetail).toContain("setCustomBotDialogOpen(true)");
		expect(agentCardsLogic).toContain("canonicalAgentChannelLinks");
		expect(agentCardsLogic).toContain("buildAgentChannelCardGroups");
		expect(agentDetail).not.toContain('<details className="group border-t pt-4">');
	});

	test("keeps Discord inventory in Console and Add/Pair actions on the Agent", () => {
		expect(connectDialog).toContain("agent_id: agentId ?? null");
		expect(connectDialog).toContain("Connect custom bot");
		expect(connectDialog).toContain("onAgentConnected");
		expect(agentDetail).toContain('linking ? "Linking…" : "Link"');
		expect(agentDetail).toContain("body: { agent_id: environmentId }");
		expect(agentDetail).toContain("setDiscordPairOpen(true)");
		expect(agentDetail).toContain("setDiscordPair({");
		expect(agentDetail).toContain("<DiscordPairDialog");
		expect(discordPairDialog).toContain("useCreatePairCode(accountId, { toastOnError: false })");
		expect(discordPairDialog).toContain("await pair.execute");
		expect(discordPairDialog).toContain(
			"verifiedDiscordPairingCommand(data.pairing_command, data.code)",
		);
		expect(discordPairDialog).toContain("pairing_command: pairingCommand");
		expect(discordPairDialog).toContain(
			"const serverInstallUrl = verifiedDiscordInstallUrl(data.discord_install_url)",
		);
		expect(discordPairDialog).toContain(
			"const userInstallUrl = verifiedDiscordInstallUrl(data.discord_user_install_url)",
		);
		expect(discordPairDialog).toContain("server_install_retryable: serverInstallRetryable");
		expect(discordPairDialog).toContain('result.pairing_command.split(" ", 1)[0]');
		expect(discordPairDialog).toContain('data-discord-pair-path="server"');
		expect(discordPairDialog).toContain('data-discord-pair-path="dm"');
		expect(discordPairDialog).toContain("Direct message");
		expect(discordPairDialog).not.toContain("If you can already open a direct message");
		expect(discordPairDialog).toContain("Add to my apps");
		expect(discordPairDialog).toContain("Discord User Install QR code");
		expect(discordPairDialog).toContain("value={result.discord_user_install_url}");
		expect(discordPairDialog).toContain("disabled={!result.discord_user_install_url}");
		expect(discordPairDialog).toContain("Direct message pairing unavailable");
		expect(discordPairDialog).toContain("Use Server pairing");
		expect(discordPairDialog).not.toContain("enable User Install");
		expect(discordPairDialog).not.toContain("applications.commands");
		expect(discordPairDialog).not.toContain("Agent-defined slash commands are server-only");
		expect(discordPairDialog).not.toContain("default install grants");
		expect(discordPairDialog).toContain("Manage");
		expect(discordPairDialog).toContain("Add to server");
		expect(discordPairDialog).toContain("value={result.discord_install_url}");
		expect(discordPairDialog).toContain('label="Discord server install QR code"');
		expect(discordPairDialog).toContain("paste this");
		expect(discordPairDialog).toContain("into the required");
		expect(discordPairDialog).toContain('label="Discord pairing command"');
		expect(discordPairDialog).toContain('label="Discord pair code"');
		expect(discordPairDialog).not.toContain("onClick={() => void copy(result.code)}");
		expect(discordPairDialog).not.toContain("/bot_pair ${");
		expect(discordPairDialog).not.toContain("discord://");
		expect(discordPairDialog).not.toContain("/bot_pair");
		expect(discordPairDialog).toContain("pairCodeExpiryLabel");
		expect(discordPairDialog).toContain("This Discord pair code has expired");
		expect(discordPairDialog).toContain("Generate new code");
		expect(discordPairDialog).toContain("Couldn't prepare Discord pairing");
		expect(discordPairDialog).toContain("Discord pairing is temporarily unavailable. Try again.");
		expect(discordPairDialog).toContain("Server install temporarily unavailable");
		expect(discordPairDialog).toContain("Retry server install");
		expect(discordPairDialog).not.toContain("server install settings are out of date");
		expect(pairingDialogUi).toContain("success: false");
		expect(hooks).toContain("if (toastOnError) toastApiError");
		expect(agentDetail).not.toContain("Commands synced. In Discord");
		expect(agentDetail).not.toContain("Paired servers and direct messages");
	});

	test("keeps Discord preparation server-owned for private and shared bots", () => {
		expect(agentDetail).toContain("visibility: bot.visibility");
		expect(discordPairDialog).not.toContain("useSyncCommands");
		expect(discordPairDialog).toContain("Creating a Discord pair code…");
	});

	test("opens the shared fixed-TTL Telegram flow immediately after a new link", () => {
		expect(agentDetail).toContain("const [telegramPair, setTelegramPair]");
		expect(agentDetail).toContain('account?.provider === "telegram"');
		expect(agentDetail).toContain("onLink={() => void submitLink(bot.id)}");
		expect(agentDetail).toContain("<TelegramPairDialog");
		expect(pairDialog).toContain("const TELEGRAM_PAIR_TTL_SECONDS = 300");
		expect(discordPairDialog).toContain("const DISCORD_PAIR_TTL_SECONDS = 300");
		expect(pairDialog).toContain("agent_link_id: agentLinkId");
		expect(pairDialog).toContain("ttl_seconds: TELEGRAM_PAIR_TTL_SECONDS");
		expect(pairDialog).toContain("openKeyRef.current === openKey");
		expect(pairDialog).toContain("useCreatePairCode(accountId, { toastOnError: false })");
		expect(pairDialog).toContain("success: false");
		expect(pairDialog).not.toContain("Select");
	});

	test("acknowledges only a newly active binding from the current pairing attempt", () => {
		expect(pairDialog).toContain("usePairingSuccess");
		expect(discordPairDialog).toContain("usePairingSuccess");
		expect(agentDetail).toContain("bindings={bindingQuery?.data}");
		expect(agentDetail).toContain("bindings={bindingsForAccount(telegramPair.accountId)}");
		expect(agentDetail).toContain("bindings={bindingsForAccount(discordPair.accountId)}");
		expect(pairingSuccess).toContain("initialActiveBindingIds: new Set");
		expect(pairingSuccess).toContain("binding.agent_link_id === agentLinkId");
		expect(pairingSuccess).toContain('binding.status.toLowerCase() === "active"');
		expect(pairingSuccess).toContain('toast.success("Chat paired"');
		expect(pairingSuccess).toContain("attempt.completed = true");
		expect(pairingSuccess).toContain("openRef.current = false");
		expect(pairDialog).toContain("onOpenChange={handlePairingOpenChange}");
		expect(discordPairDialog).toContain("onOpenChange={handlePairingOpenChange}");
		expect(pairingSuccess).toContain("onOpenChange(false)");
	});

	test("makes the validated server deep link and QR primary with a manual command fallback", () => {
		expect(pairDialog).toContain("value={validLink}");
		expect(pairDialog).toContain("href={validLink}");
		expect(pairDialog).toContain("qrPayload: result.qr_payload");
		expect(pairDialog).toContain('label="Telegram pairing QR code"');
		expect(pairDialog).toContain('"Copy link"');
		expect(pairDialog).toContain("Telegram link unavailable");
		expect(pairDialog).toContain("This Telegram link has expired");
		expect(pairDialog).toContain("Pair manually");
		expect(pairDialog).toContain("!expired && result.bot_username");
		expect(pairDialog).toContain("Send this to");
		expect(pairDialog).toContain("<CopyablePairingCode");
		expect(pairDialog).toContain('label="Telegram bot handle"');
		expect(pairDialog).toContain('variant="inline"');
		expect(pairDialog).toContain('label="Telegram pairing command"');
		expect(pairDialog).not.toContain('scope="Chat"');
		expect(pairDialog).toContain("Use the link or pairing command to connect a chat.");
		expect(pairDialog).not.toContain("Private chat or group");
		expect(pairDialog).not.toContain("Open Telegram for a private chat");
		expect(pairDialog).not.toContain("In a private chat");
		expect(pairDialog).not.toContain("group where it has been added");
		expect(pairDialog).toContain(
			'aria-label={copied ? "Telegram link copied" : "Copy Telegram link"}',
		);
		expect(discordPairDialog).not.toContain('scope="Server or direct message"');
		expect(discordPairDialog).toContain("Copy Discord install link");
		expect(pairDialog).not.toContain("agentName");
		expect(pairDialog).toContain('title="Couldn\'t create Telegram link"');
	});

	test("shares responsive dialog structure and accessible copy controls", () => {
		for (const dialog of [pairDialog, discordPairDialog]) {
			expect(dialog).toContain('<PairingDialogContent data-hosted="true" data-v2="true">');
			expect(dialog).toContain("<PairingDialogHeader");
			expect(dialog).toContain("<PairingDialogBody");
			expect(dialog).toContain("<PairingQrCode");
			expect(dialog).toContain("<PairingExpiry");
			expect(dialog).toContain("<PairingInstructionPanel");
			expect(dialog).toContain("<PairingDialogActions>");
			expect(dialog).not.toContain("<PairingDialogFooter>");
		}
		expect(pairingDialogUi).toContain("onClick={() => void copy(value)}");
		expect(pairingDialogUi).toContain('aria-live="polite"');
		expect(pairingDialogUi).toContain("rounded-md border bg-background");
		expect(pairingDialogUi).toContain('variant === "inline"');
		expect(pairingDialogUi).toContain("max-w-44 sm:max-w-48");
		expect(pairingDialogUi).toContain("data-pairing-instruction-panel");
		expect(pairingDialogUi).toContain("data-pairing-dialog-actions");
		expect(pairingDialogUi).not.toContain("scope?: string");
		expect(pairDialog).toContain("onOpenChangeComplete");
		expect(discordPairDialog).toContain("onOpenChangeComplete");
		expect(pairDialog).toContain("setResult(null)");
		expect(discordPairDialog).toContain("setResult(null)");
		expect(agentDetail).toContain("onCloseComplete={() =>");
	});

	test("shows chat identity and isolates Unpair to the selected chat with recovery", () => {
		expect(agentDetail).toContain("useChannelBindingsForAccounts(activeAccountIds)");
		expect(agentDetail).toContain("selectAgentPairedChats");
		expect(agentDetail).toContain("pairedChatsByLinkId.get(linkForBot.id) ?? []");
		expect(pairedChatRow).toContain("Only this chat will be disconnected");
		expect(pairedChatRow).toContain("<ConfirmAction");
		expect(pairedChatRow).toContain("binding_id: binding.id");
		expect(pairedChatRow).toContain("unpair.isPending");
		expect(confirmAction).toContain("void runConfirm().catch");
		expect(hooks).toContain("export function useDeleteChannelBinding");
		expect(hooks).toContain("keys.bindings(accountId)");
		expect(hooks).toContain('toastApiError("Couldn\'t unpair chat")');
		expect(hooks).toContain("refetchInterval: 3_000");
		expect(agentDetail).toContain("bindingsLoading={Boolean(bindingQuery?.isPending)}");
		expect(agentDetail).not.toContain("bindingsLoading={Boolean(bindingQuery?.isFetching)}");
		expect(agentDetail).toContain("bindingQuery?.error && bindingQuery.data === undefined");
		expect(pairedChatRow).toContain("binding.last_message_at");
		expect(pairedChatRow).toContain("Last activity {relativeTime(binding.last_message_at)}");
		expect(pairedChatRow).not.toContain("No activity yet");
		expect(agentDetail).not.toContain("Checking activity");
		expect(agentDetail).not.toContain("No activity yet");
		expect(agentDetail).not.toContain("Last activity");
		expect(pairedChatsDialog).toContain("pairedChats.map");
		expect(pairedChatsDialog).toContain("pairedChats.length === 1");
		expect(pairedChatsDialog).toContain('"chat" : "chats"');
		expect(agentDetail).not.toContain("Link to start pairing chats");
		expect(agentDetail).toContain("Agent Link gated");
		expect(agentDetail).toContain("activationGated ? (");
		expect(pairedChatsDialog).toContain("aria-controls={panelId}");
		expect(pairedChatsDialog).toContain('role="status"');
		expect(pairedChatsDialog).toContain('role="alert"');
		expect(pairedChatsDialog).toContain("onBindingsRetry");
		expect(pairedChatsDialog).not.toContain("pairedChats.slice");
		expect(pairedChatsDialog).not.toContain("Show more");
	});

	test("keeps repeated row actions visually stable without provider variants", () => {
		expect(linkedChannelRow).toContain('variant="outline"');
		expect(linkedChannelRow).toContain('size="sm"');
		expect(linkedChannelRow).toContain('<QrCode className="size-3.5" />');
		expect(linkedChannelRow).toContain("AGENT_CHANNEL_PAIR_ACTIONS_CLASS");
		expect(linkedChannelRow).not.toContain('variant={provider === "telegram"');
		expect(linkedChannelRow).not.toContain('provider === "telegram" ? "default"');
		expect(linkedChannelRow).toContain('variant="ghost"');
		expect(linkedChannelRow).toContain('size="sm"');
		expect(linkedChannelRow).toContain("CHANNEL_DESTRUCTIVE_ACTION_CLASS");
		expect(linkedChannelRow).toContain("Unlinking…");
		expect(linkedChannelRow).toContain('"Unlink"');
		expect(linkedChannelRow).toContain("<Link2Off");
		expect(linkedChannelRow).not.toContain("<Tooltip>");
		expect(pairedChatRow).toContain('variant="ghost"');
		expect(pairedChatRow).toContain('size="sm"');
		expect(pairedChatRow).toContain("CHANNEL_DESTRUCTIVE_ACTION_CLASS");
		expect(pairedChatRow).toContain("Unpairing…");
		expect(pairedChatRow).toContain('"Unpair"');
		expect(pairedChatRow).toContain("<Link2Off");
		expect(pairedChatRow).not.toContain('variant="outline"');
	});

	test("renders compact identity-first chats without duplicating provider identity", () => {
		expect(pairedChatRow).toContain("<IconChip");
		expect(pairedChatRow).toContain("<MessageCircle");
		expect(pairedChatRow).toContain("<MessagesSquare");
		expect(pairedChatRow).toContain("pairedChatTitle(binding, provider)");
		expect(pairedChatRow).toContain("binding.external_chat_name?.trim()");
		expect(pairedChatRow).toContain('titleClassName="truncate"');
		expect(pairedChatRow).toContain('<span className="shrink-0">{scopeLabel}</span>');
		expect(pairedChatRow).not.toContain("overflow-visible");
		expect(pairedChatRow).toContain("pairedChatScopeLabel(provider, binding)");
		expect(pairedChatRow).not.toContain("Run /clawdi_unpair in this");
		expect(pairedChatRowLogic).toContain("external_chat_name?.trim()");
		expect(pairedChatRowLogic).toContain("binding.external_chat_id");
		expect(pairedChatRow).not.toContain("<ProviderChip");
		expect(pairedChatRow).not.toContain("CopyInline");
		expect(pairedChatRow).not.toContain("Paired to");
		expect(pairedChatRow).not.toContain("Through");
		expect(pairedChatRow).not.toContain("border-l-2");
		expect(pairedChatRow).not.toContain("ml-4");
	});

	test("filters Agent-page chats by the visible active link and account", () => {
		expect(agentBindingLogic).toContain("activeAgentChannelLinks(visibleLinks)");
		expect(agentBindingLogic).toContain("binding.account_id !== accountId");
		expect(agentBindingLogic).toContain("linksById.get(binding.agent_link_id)");
		expect(agentBindingLogic).toContain("link.account_id !== accountId");
	});

	test("never renders returned runtime credentials", () => {
		for (const ui of [detail, pairDialog, connectDialog, agentDetail, pairedChatsDialog]) {
			expect(ui).not.toContain("TokenReveal");
			expect(ui).not.toContain("agent_token");
			expect(ui).not.toContain("Agent token");
			expect(ui).not.toContain("one-time-secret-value");
		}
	});
});
