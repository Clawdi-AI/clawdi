import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

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
		expect(channelsPage).toContain("providersWithOwnedBots(counts)");
	});

	test("uses the shared channel-linking module without dead global relationship hooks", () => {
		const channelFiles = readdirSync(new URL(".", import.meta.url));
		const agentDetail = source("../../agents/hosted-agent-detail.tsx");
		const connectDialog = source("./connect-bot-dialog.tsx");
		const pairDialog = source("./telegram-pair-dialog.tsx");
		const hooks = source("./channels-hooks.ts");

		expect(channelFiles.filter((file) => file.includes("link-agent-dialog"))).toEqual([]);
		for (const consumer of [agentDetail, connectDialog, pairDialog]) {
			expect(consumer).toContain("channel-linking.logic");
			expect(consumer).not.toContain("link-agent-dialog");
		}
		expect(hooks).not.toContain("export function useLinkAgent(");
		expect(hooks).not.toContain("export function useUnlinkChannelAgent(");
		expect(hooks).toContain("export function useUnlinkAgentChannel(");
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

	test("describes command publishing as bot-owned configuration", () => {
		const channelDetail = source("./channel-detail-page.tsx");

		expect(channelDetail).toContain('title="Pairing commands"');
		expect(channelDetail).toContain("Publish Clawdi’s pairing commands to");
		expect(channelDetail).not.toContain("Publish this agent's slash commands");
		expect(channelDetail).not.toContain("The agent returned no commands");
	});
});
