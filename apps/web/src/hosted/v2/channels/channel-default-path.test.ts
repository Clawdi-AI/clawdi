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

		expect(linkDialog).toContain("The bot is linked to this agent");
		expect(linkDialog).toContain("Next, create a pairing code");
		expect(linkDialog).toContain("agentSectionLink(");
		expect(linkDialog).toContain('"channels"');
		expect(linkDialog).toContain("agentDeploymentRouteQuery(routeSearch)");
		expect(linkDialog).toContain("Finish channel setup");
		expect(linkDialog).toContain("Agent token (advanced)");
	});

	test("uses customer-facing labels for public bot access", () => {
		const channelUi = source("./channel-ui.tsx");
		const channelDetail = source("./channel-detail-page.tsx");

		expect(channelUi).toContain('owner ? "Your bot" : "Ready to use"');
		expect(channelDetail).toContain('"Ready-to-go bot" : "Your bot"');
		expect(channelDetail).not.toContain('"Shared bot"');
	});
});
