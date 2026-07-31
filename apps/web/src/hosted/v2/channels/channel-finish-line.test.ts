import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const agentChannels = readFileSync(
	new URL("../../agents/hosted-agent-detail.tsx", import.meta.url),
	"utf8",
);
const channelDetail = readFileSync(new URL("./channel-detail-page.tsx", import.meta.url), "utf8");
const channelHooks = readFileSync(new URL("./channels-hooks.ts", import.meta.url), "utf8");
const linkAgentDialog = readFileSync(new URL("./link-agent-dialog.tsx", import.meta.url), "utf8");
const channelsTab = agentChannels.slice(
	agentChannels.indexOf("function ChannelsTab"),
	agentChannels.indexOf("// ── Settings / Compute"),
);

describe("hosted-agent channel finish line", () => {
	test("keeps diagnosis compact inside a shared connected-channel row", () => {
		expect(channelsTab).toContain("const health = useChannelHealth()");
		expect(channelsTab).toContain("channelActivityAfterLink(");
		expect(channelsTab).toContain("AGENT_CHANNEL_LIST_CLASS");
		expect(channelsTab).toContain("AGENT_CHANNEL_ROW_CLASS");
		expect(channelsTab).toContain("Last activity");
		expect(channelsTab).toContain("No activity yet");
		expect(channelsTab).toContain("Activity unavailable · Retry");
		expect(channelsTab).toContain("<ChannelStatusBadge status={link.status} />");
		expect(channelsTab).toContain("<HealthBadge");
		expect(channelsTab).not.toContain("Waiting for channel activity");
		expect(channelsTab).not.toContain("This page checks automatically every 20 seconds");
	});

	test("separates linking a channel from pairing a chat with one short instruction", () => {
		expect(channelsTab).toContain(
			"Link a bot to this Agent, then pair the chats it should answer.",
		);
		expect(channelsTab).toContain("Pair Telegram");
		expect(channelsTab).toContain("Pair chat");
		expect(channelsTab).toContain("<TelegramPairDialog");
		expect(channelsTab).toContain("agentLinkId={link.id}");
		expect(channelsTab).toContain("pairing_command");
		expect(channelsTab).not.toContain("Agent token");
		expect(channelsTab).not.toContain("credential sync");
		expect(channelsTab).not.toContain("source revision");
	});

	test("orders the page by connected channels, paired chats, then channel addition", () => {
		const connectedIndex = channelsTab.indexOf("<section data-agent-connected-channels");
		const pairedIndex = channelsTab.indexOf("<AgentPairedChats");
		const addIndex = channelsTab.indexOf("<section data-agent-add-channel");
		const readyBotIndex = channelsTab.indexOf('kind="Ready to use"');
		const advancedIndex = channelsTab.indexOf("Use your own bot");
		expect(connectedIndex).toBeGreaterThanOrEqual(0);
		expect(pairedIndex).toBeGreaterThan(connectedIndex);
		expect(addIndex).toBeGreaterThan(pairedIndex);
		expect(readyBotIndex).toBeGreaterThan(addIndex);
		expect(advancedIndex).toBeGreaterThan(readyBotIndex);
		expect(channelsTab).toContain("data-agent-connected-channels");
		expect(channelsTab).toContain("data-agent-paired-chats");
		expect(channelsTab).toContain("Paired chats");
		expect(channelsTab).toContain("data-agent-add-channel");
		expect(channelsTab).toContain("data-add-channel-id");
		expect(channelsTab).not.toContain("No bot connected yet");
		expect(channelsTab).toContain("Connect a bot");
		expect(channelsTab).not.toContain("View all channels");
		expect(channelsTab).not.toContain("setAdvancedOpen");
		expect(channelsTab).toContain('<details className="group border-t pt-4">');
		expect(channelsTab).not.toContain("Fastest: use a ready-to-go bot");
		expect(channelsTab).not.toContain("Use your own bot (advanced)");
	});

	test("replaces setup jargon with a bounded automatic wait and exits", () => {
		expect(agentChannels).toContain('title="Getting channels ready"');
		expect(agentChannels).toContain("This usually takes a few minutes");
		expect(agentChannels).toContain("Choose a channel while you wait");
		expect(agentChannels).not.toContain("minting its cloud agent id");
		expect(agentChannels).not.toContain("shared-pool");
	});

	test("describes channel setup without infrastructure vocabulary", () => {
		const customerCopy = `${channelDetail}\n${channelHooks}\n${linkAgentDialog}`;
		expect(customerCopy).toContain("Open the agent’s Channels page");
		expect(channelDetail).not.toContain("Mint a device credential");
		expect(channelDetail).not.toContain("The agent runtime uses");
		expect(channelDetail).not.toContain("The runtime returned");
		expect(channelHooks).not.toContain('description: "Finish pairing from the agent runtime');
		expect(linkAgentDialog).not.toContain("Finish device pairing from the agent runtime");
		expect(linkAgentDialog).not.toContain("self-managed runtime that asks for it");
	});
});
