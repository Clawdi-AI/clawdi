import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("global Channels inventory", () => {
	test("separates Custom and Clawdi bot inventory without relationship actions", () => {
		const channelsPage = source("./channels-page.tsx");

		expect(channelsPage).toContain("<OwnedBotsSection");
		expect(channelsPage).toContain("data-owned-bots-section");
		expect(channelsPage).toContain("<SharedBotsSection");
		expect(channelsPage).toContain("data-shared-bots-section");
		expect(channelsPage).toContain("Add channel");
		expect(channelsPage).toContain("Custom bots");
		expect(channelsPage).toContain("Clawdi bots");
		expect(channelsPage).toContain("orderedChannelsForFilter");
		expect(channelsPage).toContain("useBotPool");
		expect(channelsPage).not.toContain("ReadyBotsSection");
		expect(channelsPage).not.toContain("Ready-to-go bots");
		expect(channelsPage).not.toContain("data-ready-bots-section");
		expect(channelsPage).not.toContain("data-pool-account-id");
		expect(channelsPage).not.toContain("LinkAgentDialog");
		expect(channelsPage).not.toContain("Link an agent");
		expect(channelsPage).toContain("Delete custom bot");
		expect(channelsPage).not.toContain("At capacity");
		expect(channelsPage).toContain("providersWithBots(counts)");
		expect(channelsPage).not.toContain("· Shared");
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

	test("reuses one Add channel dialog for Console inventory and direct Agent setup", () => {
		const connectDialog = source("./connect-bot-dialog.tsx");
		const connectDialogLogic = source("./connect-bot-dialog.logic.ts");
		const replacementConfirm = source("./provider-link-replacement-confirm.tsx");
		const agentDetail = source("../../agents/hosted-agent-detail.tsx");

		expect(connectDialogLogic).toContain("replace_existing_provider_link: true");
		expect(connectDialog).toContain("<ProviderLinkReplacementConfirm");
		expect(connectDialog).toContain('onAddWithoutLinking={() => submit("inventory-only")}');
		expect(replacementConfirm).toContain('label: "Add without linking"');
		expect(replacementConfirm).toContain("? `How should this ");
		expect(replacementConfirm).toContain("This Agent can link only one");
		expect(replacementConfirm).toContain(": `Replace this Agent’s ");
		expect(connectDialog).toContain("onAgentConnected");
		expect(connectDialog).toContain("autoLinkAgentIdForNewCustomBot");
		expect(agentDetail).not.toContain("<AddChannelDialog");
		expect(agentDetail).toContain("<ConnectBotDialog");
		expect(agentDetail).toContain("open={customBotDialogOpen}");
		expect(agentDetail).toContain("agentId={environmentId}");
		expect(agentDetail).toContain("linkedProviders={linked.data ? linkedProviders : undefined}");
		expect(agentDetail).not.toContain("agentRouteQuery=");
		expect(agentDetail).toContain("Add channel");
		expect(agentDetail).toContain('title="Clawdi bots"');
		expect(agentDetail).toContain('title="Custom bots"');
		expect(agentDetail).toContain("setTelegramPair({");
	});

	test("renders a compact credential form with official external links", () => {
		const connectDialog = source("./connect-bot-dialog.tsx");

		expect(connectDialog).toContain("href={meta.setupUrl}");
		expect(connectDialog).toContain('target="_blank"');
		expect(connectDialog).toContain("Application ID");
		expect(connectDialog).toContain("Public key");
		expect(connectDialog).not.toContain("setupSteps");
		expect(connectDialog).toContain("whatsappSelected");
		expect(connectDialog).toContain("<WhatsAppDeviceOnboarding");
		expect(connectDialog).toContain("Need a provider that Clawdi Channels");
		expect(connectDialog).toContain('agentSectionLink(agentId, "console")');
		expect(connectDialog).toContain("Open the relevant Agent's Agent Interface");
		expect(connectDialog).toContain("data-agent-link-warning");
		expect(connectDialog).toContain('className="border-warning/30 bg-warning-muted py-2.5"');
		expect(connectDialog).toContain("<TriangleAlert aria-hidden />");
		expect(connectDialog).toContain('title: "Agent link status unavailable"');
		expect(connectDialog).toContain(
			"The new Custom bot will be linked to this Agent automatically.",
		);
		expect(connectDialog).not.toContain("Server ID");
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
