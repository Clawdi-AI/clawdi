import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const agentChannels = readFileSync(
	new URL("../../agents/hosted-agent-detail.tsx", import.meta.url),
	"utf8",
);
const channelDetail = readFileSync(new URL("./channel-detail-page.tsx", import.meta.url), "utf8");
const channelHooks = readFileSync(new URL("./channels-hooks.ts", import.meta.url), "utf8");
const channelsTab = agentChannels.slice(
	agentChannels.indexOf("function ChannelsTab"),
	agentChannels.indexOf("// ── Settings / Compute"),
);

describe("hosted-agent channel finish line", () => {
	test("keeps diagnosis compact inside shared content-height channel cards", () => {
		expect(channelsTab).toContain("const health = useChannelHealth()");
		expect(channelsTab).toContain("CHANNEL_CARD_GRID_CLASS");
		expect(channelsTab).toContain("<ChannelCard");
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
		expect(channelsTab).toContain("<HealthBadge");
		expect(channelsTab).not.toContain("Waiting for channel activity");
		expect(channelsTab).not.toContain("This page checks automatically every 20 seconds");
	});

	test("separates linking a channel from pairing a chat with one short instruction", () => {
		expect(channelsTab).toContain("Link a bot to this Agent, then choose where it should answer.");
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

	test("keeps Add persistent and nests progressively disclosed chats inside their bot", () => {
		const connectedIndex = channelsTab.indexOf("<section data-agent-connected-channels");
		const addIndex = channelsTab.indexOf("data-agent-add-channel");
		const availableIndex = channelsTab.indexOf("<section data-agent-available-channels");
		const readyBotIndex = channelsTab.indexOf('kind="Shared bot"');
		expect(connectedIndex).toBeGreaterThanOrEqual(0);
		expect(addIndex).toBeGreaterThan(connectedIndex);
		expect(availableIndex).toBeGreaterThan(addIndex);
		expect(readyBotIndex).toBeGreaterThan(availableIndex);
		expect(channelsTab).toContain("data-agent-connected-channels");
		expect(channelsTab).toContain("data-agent-channel-group-id={link.id}");
		expect(channelsTab).toContain("data-agent-channel-chats-for={link.id}");
		expect(channelsTab).not.toContain("data-agent-paired-chats");
		expect(channelsTab).toContain("Paired chats");
		expect(channelsTab).not.toContain("No chats paired");
		expect(channelsTab).toContain("data-agent-add-channel");
		expect(channelsTab).toContain("const showAvailableBotsSection =");
		expect(channelsTab).toContain("{showAvailableBotsSection ? (");
		const availableSectionGate = channelsTab.slice(
			channelsTab.indexOf("const showAvailableBotsSection ="),
			channelsTab.indexOf("const healthByAccount"),
		);
		expect(availableSectionGate).toContain("readyBots.length > 0");
		expect(availableSectionGate).toContain("botPool.isLoading");
		expect(availableSectionGate).toContain("botPool.error");
		expect(addIndex).toBeLessThan(channelsTab.indexOf("{showAvailableBotsSection ? ("));
		expect(channelsTab).toContain("data-add-channel-id");
		expect(channelsTab).not.toContain("No bot connected yet");
		expect(channelsTab).not.toContain("View all channels");
		expect(channelsTab).not.toContain("setAdvancedOpen");
		expect(channelsTab).not.toContain('<details className="group border-t pt-4">');
		expect(channelsTab).not.toContain("Fastest: use a ready-to-go bot");
		expect(channelsTab).not.toContain("Use your own bot (advanced)");
		expect(agentChannels).toContain("INITIAL_PAIRED_CHAT_COUNT = 3");
		expect(channelsTab).toContain("pairedChats.slice(0, INITIAL_PAIRED_CHAT_COUNT)");
		expect(channelsTab).toContain("const pairedChatsLabel =");
		expect(channelsTab).toContain("Paired chats ·");
		expect(channelsTab).toContain("aria-expanded={chatsOpen}");
		expect(channelsTab).toContain("aria-controls={chatsId}");
		expect(channelsTab).toContain("hidden={!chatsOpen}");
		expect(channelsTab).toContain('showAllChats ? "Show less" : "Show more"');
		expect(channelsTab).toContain("Show less");
		expect(channelsTab).toContain("onBindingsRetry");
		expect(channelsTab).toContain("Loading paired chats");
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
