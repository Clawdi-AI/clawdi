import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("channel default path", () => {
	test("puts ready-to-go bots before personal bot management", () => {
		const channelsPage = source("./channels-page.tsx");
		const readyIndex = channelsPage.indexOf("<ReadyBotsSection");
		const personalIndex = channelsPage.indexOf("<YourChannelsSection");

		expect(readyIndex).toBeGreaterThanOrEqual(0);
		expect(personalIndex).toBeGreaterThan(readyIndex);
		expect(channelsPage).toContain("Start instantly with a ready-to-go bot");
		expect(channelsPage).toContain("Connect your own bot");
		expect(channelsPage).toContain("Ready-to-go bots");
		expect(channelsPage).toContain("orderedChannelsForFilter");
		expect(channelsPage).toContain("orderedPoolItemsForFilter");
		expect(channelsPage).toContain("data-ready-bots-section");
		expect(channelsPage).toContain("data-your-bots-section");
		expect(channelsPage).not.toContain("ProviderChannelGroup");
		expect(channelsPage).not.toContain("function channelGroups");
		expect(channelsPage).not.toContain("function poolGroups");
		expect(channelsPage).not.toContain("Shared bots");
		expect(channelsPage).not.toContain("shared bot");
	});

	test("renders actionable provider steps and real external links in the connect dialog", () => {
		const connectDialog = source("./connect-bot-dialog.tsx");

		expect(connectDialog).toContain("meta.setupSteps.map");
		expect(connectDialog).toContain("href={meta.setupUrl}");
		expect(connectDialog).toContain('target="_blank"');
		expect(connectDialog).toContain("This is the name shown in Clawdi");
		expect(connectDialog).toContain("Server ID");
		expect(connectDialog).not.toContain("Guild ID");
	});

	test("moves a successful ready-bot link into the agent finish line", () => {
		const linkDialog = source("./link-agent-dialog.tsx");

		expect(linkDialog).toContain("Pair a Telegram");
		expect(linkDialog).toContain("chat now or manage it from the Agent");
		expect(linkDialog).toContain("Linked · syncing automatically");
		expect(linkDialog).not.toContain("exact chat");
		expect(linkDialog.match(/!selectedAgent/g)).toHaveLength(1);
		expect(linkDialog).toContain("const submitBlocked");
		expect(linkDialog).toContain("agentSectionLink(");
		expect(linkDialog).toContain('"channels"');
		expect(linkDialog).toContain("agentDeploymentRouteQuery(routeSearch)");
		expect(linkDialog).toContain("Open Agent Channels");
		expect(linkDialog).not.toContain("agent_token");
		expect(linkDialog).not.toContain("Agent token");
	});

	test("does not repeat pool access labels on cards or detail", () => {
		const channelsPage = source("./channels-page.tsx");
		const channelDetail = source("./channel-detail-page.tsx");

		expect(channelsPage).not.toContain("AccessBadge");
		expect(channelsPage).not.toContain("Ready to use");
		expect(channelDetail).not.toContain("Ready-to-go bot");
		expect(channelDetail).not.toContain(["description={`", "$", "{meta.label} ·"].join(""));
		expect(channelDetail).not.toContain('"Shared bot"');
	});
});
