import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("global Channels inventory", () => {
	test("shows only owned bot assets and never exposes the ready-bot linking flow", () => {
		const channelsPage = source("./channels-page.tsx");

		expect(channelsPage).toContain("<OwnedBotsSection");
		expect(channelsPage).toContain("data-owned-bots-section");
		expect(channelsPage).toContain("Manage the bots you own");
		expect(channelsPage).toContain("Connect bot");
		expect(channelsPage).toContain("orderedChannelsForFilter");
		expect(channelsPage).not.toContain("useBotPool");
		expect(channelsPage).not.toContain("ReadyBotsSection");
		expect(channelsPage).not.toContain("Ready-to-go bots");
		expect(channelsPage).not.toContain("data-ready-bots-section");
		expect(channelsPage).not.toContain("data-pool-account-id");
		expect(channelsPage).not.toContain("LinkAgentDialog");
		expect(channelsPage).not.toContain("Link an agent");
		expect(channelsPage).not.toContain("At capacity");
	});

	test("creates an unlinked asset globally and targets the current Agent only in Agent context", () => {
		const connectDialog = source("./connect-bot-dialog.tsx");
		const agentDetail = source("../../agents/hosted-agent-detail.tsx");

		expect(connectDialog).toContain("const linkTarget = { agent_id: agentId ?? null }");
		expect(agentDetail).toContain("agentId={environmentId}");
		expect(agentDetail).toContain("onAgentConnected={(bot)");
		expect(agentDetail).toContain("setTelegramPair({");
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

	test("does not repeat provider or normal-state labels on inventory cards", () => {
		const channelsPage = source("./channels-page.tsx");
		const channelDetail = source("./channel-detail-page.tsx");

		expect(channelsPage).not.toContain("AccessBadge");
		expect(channelsPage).not.toContain("Ready to use");
		expect(channelDetail).not.toContain("description={`");
		expect(channelDetail).not.toContain('"Shared bot"');
	});
});
