import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const agentChannels = readFileSync(
	new URL("../../agents/hosted-agent-detail.tsx", import.meta.url),
	"utf8",
);
const channelDetail = readFileSync(new URL("./channel-detail-page.tsx", import.meta.url), "utf8");
const channelHooks = readFileSync(new URL("./channels-hooks.ts", import.meta.url), "utf8");
const pairedChatsDialog = readFileSync(
	new URL("./paired-chats-dialog.tsx", import.meta.url),
	"utf8",
);
const channelsTab = agentChannels.slice(
	agentChannels.indexOf("function ChannelsTab"),
	agentChannels.indexOf("// ── Settings / Compute"),
);

describe("hosted-agent channel finish line", () => {
	test("keeps diagnosis compact inside shared equal-height channel cards", () => {
		expect(channelsTab).toContain("const health = useChannelHealth()");
		expect(channelsTab).toContain("CHANNEL_CARD_GRID_CLASS");
		expect(channelsTab).toContain("<AgentChannelCard");
		expect(channelsTab).not.toContain("AGENT_CHANNEL_LIST_CLASS");
		expect(channelsTab).not.toContain("AGENT_CHANNEL_ROW_CLASS");
		expect(channelsTab).not.toContain("channelActivityAfterLink(");
		expect(channelsTab).not.toContain("Last activity");
		expect(channelsTab).not.toContain("No activity yet");
		expect(channelsTab).not.toContain("Checking activity");
		expect(channelsTab).toContain("health.error && visibleActiveLinks.length > 0");
		expect(channelsTab).toContain('title="Couldn\'t refresh channel health"');
		expect(channelsTab).toContain("onRetry={() => void health.refetch()}");
		expect(channelsTab).toContain('<ChannelStatusBadge key="status" status={link.status} />');
		expect(channelsTab).toContain('<HealthBadge key="health" health={health} />');
		expect(channelsTab).not.toContain("status={health.health_status}");
		expect(channelsTab).toContain('state={unavailableReason ?? "Available"}');
		expect(channelsTab).toContain('isNormalChannelStatus(link.status) ? (\n\t\t\t"Linked"');
		expect(channelsTab).toContain("Link to start pairing chats");
		expect(channelsTab).not.toContain('key="paired"');
		expect(channelsTab).not.toContain("pairedChatCount");
		expect(channelsTab).not.toContain('1 ? "chat" : "chats"');
		expect(channelsTab).not.toContain("Waiting for channel activity");
		expect(channelsTab).not.toContain("This page checks automatically every 20 seconds");
	});

	test("separates linking a bot from pairing a chat on one stable card", () => {
		expect(channelsTab).toContain('linking ? "Linking…" : "Link"');
		expect(channelsTab).toContain("data-agent-channel-account-id={bot.id}");
		expect(channelsTab).toContain("Pair Telegram");
		expect(channelsTab).toContain("pairingActionLabel(provider)");
		expect(channelsTab).toContain("<TelegramPairDialog");
		expect(channelsTab).toContain("<DiscordPairDialog");
		expect(channelsTab).toContain("agentLinkId={link.id}");
		expect(channelsTab).toContain("pairing_command");
		expect(channelsTab).not.toContain("Agent token");
		expect(channelsTab).not.toContain("credential sync");
		expect(channelsTab).not.toContain("source revision");
	});

	test("renders direct Clawdi and Custom groups with the sole custom creation action", () => {
		const clawdiIndex = channelsTab.indexOf('title="Clawdi bots"');
		const customIndex = channelsTab.indexOf('title="Custom bots"');
		const addCustomIndex = channelsTab.indexOf("data-agent-add-custom-bot");
		expect(clawdiIndex).toBeGreaterThanOrEqual(0);
		expect(customIndex).toBeGreaterThan(clawdiIndex);
		expect(addCustomIndex).toBeGreaterThan(customIndex);
		expect(channelsTab).toContain("data-agent-channels");
		expect(channelsTab).toContain("data-agent-channel-group-id={link.id}");
		expect(channelsTab).toContain("<PairedChatsDialog");
		expect(pairedChatsDialog).toContain("data-agent-channel-chats-for={linkId}");
		expect(channelsTab).not.toContain("data-agent-paired-chats");
		expect(pairedChatsDialog).toContain("Paired chats");
		expect(channelsTab).not.toContain("No chats paired");
		expect(channelsTab).toContain("data-agent-add-custom-bot");
		expect(channelsTab).not.toContain("<AddChannelDialog");
		expect(channelsTab).toContain("Clawdi bots");
		expect(channelsTab).toContain("Custom bots");
		expect(channelsTab).not.toContain("No bot connected yet");
		expect(channelsTab).not.toContain("View all channels");
		expect(channelsTab).not.toContain("setAdvancedOpen");
		expect(channelsTab).not.toContain('<details className="group border-t pt-4">');
		expect(channelsTab).not.toContain("Fastest: use a ready-to-go bot");
		expect(channelsTab).not.toContain("Use your own bot (advanced)");
		expect(pairedChatsDialog).toContain("pairedChats.map");
		expect(pairedChatsDialog).toContain("Manage paired chats ·");
		expect(pairedChatsDialog).toContain("h-10 min-h-10 max-h-10");
		expect(pairedChatsDialog).toContain("overflow-y-auto");
		expect(pairedChatsDialog).toContain("<Dialog");
		expect(pairedChatsDialog).toContain("<Sheet");
		expect(pairedChatsDialog).not.toContain("Show more");
		expect(pairedChatsDialog).not.toContain("Show less");
		expect(channelsTab).toContain("onBindingsRetry");
		expect(pairedChatsDialog).toContain("Loading paired chats");
	});

	test("replaces setup jargon with a bounded automatic wait and exits", () => {
		expect(agentChannels).toContain('title="Getting channels ready"');
		expect(agentChannels).toContain("This usually takes a few minutes");
		expect(agentChannels).toContain("Choose a channel while you wait");
		expect(agentChannels).not.toContain("minting its cloud agent id");
		expect(agentChannels).not.toContain("shared-pool");
	});

	test("describes channel setup without infrastructure vocabulary", () => {
		const customerCopy = `${channelDetail}\n${channelHooks}`;
		expect(customerCopy).toContain("Open the agent’s Channels page");
		expect(channelDetail).not.toContain("Mint a device credential");
		expect(channelDetail).not.toContain("The agent runtime uses");
		expect(channelDetail).not.toContain("The runtime returned");
		expect(channelHooks).not.toContain('description: "Finish pairing from the agent runtime');
	});
});
