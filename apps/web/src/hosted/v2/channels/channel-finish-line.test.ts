import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const agentChannels = readFileSync(
	new URL("../../agents/hosted-agent-detail.tsx", import.meta.url),
	"utf8",
);
const channelDetail = readFileSync(new URL("./channel-detail-page.tsx", import.meta.url), "utf8");
const channelHooks = readFileSync(new URL("./channels-hooks.ts", import.meta.url), "utf8");
const linkAgentDialog = readFileSync(new URL("./link-agent-dialog.tsx", import.meta.url), "utf8");

describe("hosted-agent channel finish line", () => {
	test("assembles the existing live health query into an honest automatic activity state", () => {
		expect(agentChannels).toContain("const health = useChannelHealth()");
		expect(agentChannels).toContain("channelActivityAfterLink(");
		expect(agentChannels).toContain("This page checks automatically every 20 seconds");
		expect(agentChannels).toContain("Channel activity detected");
		expect(agentChannels).toContain(
			"This signal does not yet confirm that the agent received a normal message.",
		);
		expect(agentChannels).toContain("<ChannelStatusBadge status={link.status} />");
		expect(agentChannels).toContain("<HealthBadge");
	});

	test("explains linking, pairing, the target conversation, and the hosted token boundary", () => {
		expect(agentChannels).toContain("Choose the chat where this Agent should answer.");
		expect(agentChannels).toContain("Pair Telegram");
		expect(agentChannels).toContain("Generate Telegram link");
		expect(agentChannels).toContain("Open @${code.bot_username");
		expect(agentChannels).toContain("Open Discord and choose the server channel");
		expect(agentChannels).toContain("Create pairing code");
		expect(agentChannels).toContain("Hosted agents apply channel credentials automatically");
		expect(agentChannels).not.toContain("Agent token");
	});

	test("leads with the no-credential path and gives the empty advanced path a primary action", () => {
		const readyBotIndex = agentChannels.indexOf("Fastest: use a ready-to-go bot");
		const advancedIndex = agentChannels.indexOf("Use your own bot (advanced)");
		expect(readyBotIndex).toBeGreaterThanOrEqual(0);
		expect(advancedIndex).toBeGreaterThan(readyBotIndex);
		expect(agentChannels).toContain("No bot account, credentials, or developer setup");
		expect(agentChannels).toContain("No bot connected yet");
		expect(agentChannels).toContain("Connect my bot");
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
