import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelCard } from "./channel-card";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const card = source("./channel-card.tsx");
const consoleChannels = source("./channels-page.tsx");
const agentChannels = source("../../agents/hosted-agent-detail.tsx");
const pairedChatsDialog = source("./paired-chats-dialog.tsx");

describe("shared Channel card", () => {
	test("renders the hosted v2 Entity Card shell with aligned headers", () => {
		const markup = renderToStaticMarkup(
			createElement(ChannelCard, {
				provider: "telegram",
				title: "Support Telegram",
				actions: createElement("button", { type: "button" }, "Pair"),
			}),
		);

		expect(markup).toContain('data-hosted="true"');
		expect(markup).toContain('data-v2="true"');
		expect(markup).toContain("data-channel-card-header");
		expect(markup).toContain("min-h-20");
		expect(markup).toContain("data-channel-card-actions");
		expect(markup).toContain("h-full");
		expect(markup).toContain("flex-1");
		expect(markup).toContain("content-center");
		expect(markup).toContain(">Support Telegram<");
		expect(markup).toContain(">Pair<");
		expect(markup).not.toContain("data-channel-card-footer");

		expect(card).toContain("ENTITY_CARD_BASE");
		expect(card).toContain("ENTITY_GRID_CLASS");
		expect(card).toContain('"items-stretch xl:grid-cols-2"');
	});

	test("keeps status filler out of Console-style inventory cards", () => {
		const markup = renderToStaticMarkup(
			createElement(ChannelCard, {
				provider: "discord",
				title: "Community Discord",
				actions: createElement("button", { type: "button" }, "Link"),
			}),
		);

		expect(markup).toContain("data-channel-card-header");
		expect(markup).toContain("flex-1");
		expect(markup).not.toContain("data-channel-card-footer");
		expect(markup).not.toContain("Available");
		expect(markup).not.toContain("Linked");
	});

	test("is reused by Console inventory and Agent channel cards", () => {
		expect(consoleChannels).toContain("ChannelCard as SharedChannelCard");
		expect(consoleChannels).toContain("CHANNEL_CARD_GRID_CLASS");
		expect(consoleChannels).toContain("<SharedChannelCard");
		expect(agentChannels).toContain('from "@/hosted/v2/channels/channel-card"');
		expect(agentChannels).toContain("<AgentChannelCard");
		expect(agentChannels).toContain("CHANNEL_CARD_GRID_CLASS");
	});

	test("keeps relationship actions off Console Channels", () => {
		expect(consoleChannels).not.toContain("Pair Telegram");
		expect(consoleChannels).not.toContain("Pair Discord");
		expect(consoleChannels).not.toContain("Unpair");
		expect(consoleChannels).not.toContain("Unlink");
		expect(consoleChannels).not.toContain("Link to start pairing chats");
		expect(consoleChannels).toContain('to="/channels/$id"');
	});

	test("passes complete health records to card badges", () => {
		expect(consoleChannels).toContain(
			"new Map(healthItems.map((item) => [item.account_id, item]))",
		);
		expect(consoleChannels).toContain('<HealthBadge key="health" health={health} />');
		expect(consoleChannels).not.toContain("status={health}");
		expect(agentChannels).not.toContain("HealthBadge");
		expect(agentChannels).not.toContain("useChannelHealth");
		expect(agentChannels).not.toContain("ChannelHealthItemResponse");
	});

	test("keeps Agent channel cards equal-height without surface-specific footers", () => {
		expect(agentChannels).not.toContain("data-agent-channel-link-guidance");
		expect(agentChannels).not.toContain("Link to start pairing chats");
		expect(agentChannels).toContain(
			"type AgentChannelCardProps = ComponentProps<typeof ChannelCard>",
		);
		expect(card).not.toContain("children");
		expect(card).not.toContain("data-channel-card-footer");
		expect(agentChannels).toContain("h-[7.5rem] flex-none grid-rows-[2.75rem_2rem]");
		expect(agentChannels).toContain("xl:h-20 xl:grid-rows-1");
		expect(agentChannels).toContain('state={unavailableReason ?? "Available"}');
		expect(agentChannels).toContain("pairedChatsControl");
		expect(agentChannels).not.toContain('isNormalChannelStatus(link.status) ? (\n\t\t\t"Linked"');
		expect(consoleChannels).not.toContain('state="Available"');
		expect(consoleChannels).not.toContain('state="Linked"');
	});

	test("opens paired chats outside the card through responsive design-system overlays", () => {
		expect(agentChannels).toContain("<PairedChatsDialog");
		expect(pairedChatsDialog).toContain("<Dialog");
		expect(pairedChatsDialog).toContain("<DialogTrigger");
		expect(pairedChatsDialog).toContain("<Sheet");
		expect(pairedChatsDialog).toContain("<SheetTrigger");
		expect(pairedChatsDialog).toContain("useIsMobile()");
		expect(pairedChatsDialog).toContain('side="bottom"');
		expect(pairedChatsDialog).toContain("overflow-y-auto");
		expect(pairedChatsDialog).toContain('size: "xs"');
		expect(pairedChatsDialog).toContain("bindingCount === 1");
		expect(pairedChatsDialog).toContain('"chat" : "chats"');
		expect(pairedChatsDialog).toContain("aria-controls={panelId}");
		expect(pairedChatsDialog).not.toContain("Show more");
		expect(pairedChatsDialog).not.toContain("Show less");
	});
});
