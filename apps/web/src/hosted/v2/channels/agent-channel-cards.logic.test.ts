import { describe, expect, test } from "bun:test";
import type { AgentChannelLink } from "@/hosted/v2/channels/channel-edit-client.logic";
import type { ChannelAccount, ChannelBotPoolItem } from "@/hosted/v2/channels/channel-types";
import {
	activeAgentLinkForAccount,
	buildAgentChannelCardGroups,
	canonicalAgentChannelLinks,
} from "./agent-channel-cards.logic";

const agentId = "11111111-1111-4111-8111-111111111111";

function account(id: string, visibility: "private" | "public" = "private"): ChannelAccount {
	return {
		id,
		provider: "telegram",
		name: `Bot ${id}`,
		status: "active",
		visibility,
		has_provider_token: true,
		webhook_url: `https://example.test/${id}`,
		created_at: "2026-08-01T00:00:00Z",
	};
}

function poolBot(id: string, access: "owner" | "public"): ChannelBotPoolItem {
	return {
		...account(id, access === "public" ? "public" : "private"),
		access,
		capabilities: {
			link_agent: true,
			pair_chat: true,
			send_message: true,
			manage_account: access === "owner",
			sync_commands: access === "owner",
		},
		link_count: 0,
		max_links: null,
		available: true,
	};
}

function link(
	id: string,
	accountId: string,
	createdAt: string,
	overrides: Partial<AgentChannelLink> = {},
): AgentChannelLink {
	return {
		id,
		account_id: accountId,
		agent_id: agentId,
		status: "active",
		created_at: createdAt,
		...overrides,
		binding_count: overrides.binding_count ?? 0,
	};
}

describe("Agent channel card normalization", () => {
	test("keeps one deterministic active link per bot and ignores another Agent", () => {
		const older = link("link-a", "bot-a", "2026-08-01T00:00:00Z");
		const newer = link("link-b", "bot-a", "2026-08-01T01:00:00Z");
		const anotherAgent = link("link-c", "bot-a", "2026-08-01T02:00:00Z", {
			agent_id: "22222222-2222-4222-8222-222222222222",
		});
		const archived = link("link-d", "bot-b", "2026-08-01T03:00:00Z", {
			status: "archived",
		});

		expect(
			canonicalAgentChannelLinks({ links: [older, newer, anotherAgent, archived], agentId }),
		).toEqual([newer]);
	});

	test("preserves optimistic links for multiple bots until stale queries catch up", () => {
		const stale = link("stale", "bot-a", "2026-08-01T02:00:00Z");
		const recentA = link("recent-a", "bot-a", "2026-08-01T01:00:00Z");
		const recentB = link("recent-b", "bot-b", "2026-08-01T01:00:00Z");

		expect(
			canonicalAgentChannelLinks({ links: [stale], agentId, recentLinks: [recentA, recentB] }),
		).toEqual([recentA, recentB]);
	});

	test("uses the aggregate binding count when a recent link has the same identity", () => {
		const recent = link("same", "bot-a", "2026-08-01T01:00:00Z", {
			binding_count: 0,
		});
		const aggregate = { ...recent, binding_count: 2 };

		expect(
			canonicalAgentChannelLinks({
				links: [aggregate],
				recentLinks: [recent],
				agentId,
			}),
		).toEqual([aggregate]);
	});

	test("does not adopt another Agent's link for the same public bot", () => {
		const shared = poolBot("shared", "public");
		const anotherAgentLink = link("other-agent", shared.id, "2026-08-01T00:00:00Z", {
			agent_id: "22222222-2222-4222-8222-222222222222",
		});
		const currentAgentLinks = canonicalAgentChannelLinks({
			links: [anotherAgentLink],
			agentId,
		});

		const groups = buildAgentChannelCardGroups({
			channels: [],
			poolProviders: { telegram: [shared] },
			links: currentAgentLinks,
		});

		expect(groups.clawdiBots).toHaveLength(1);
		expect(groups.clawdiBots[0]?.link).toBeNull();
	});

	test("deduplicates list and pool records into stable Clawdi and Custom cards", () => {
		const custom = account("custom");
		const shared = poolBot("shared", "public");
		const duplicateShared = { ...shared, name: "Current shared name" };
		const customLink = link("custom-link", custom.id, "2026-08-01T00:00:00Z", {
			account: custom,
		});

		const groups = buildAgentChannelCardGroups({
			channels: [custom, custom],
			poolProviders: { telegram: [shared, duplicateShared, poolBot("custom", "owner")] },
			links: [customLink],
		});

		expect(groups.clawdiBots).toHaveLength(1);
		expect(groups.clawdiBots[0]?.name).toBe("Current shared name");
		expect(groups.customBots).toHaveLength(1);
		expect(groups.customBots[0]?.link?.id).toBe(customLink.id);
	});

	test("reconciles an idempotent or conflict response only to this bot on this Agent", () => {
		const expected = link("expected", "shared", "2026-08-01T00:00:00Z");
		const otherBot = link("other", "other", "2026-08-01T00:00:00Z");
		const otherAgent = link("other-agent", "shared", "2026-08-01T00:00:00Z", {
			agent_id: "22222222-2222-4222-8222-222222222222",
		});

		expect(
			activeAgentLinkForAccount({
				links: [otherBot, otherAgent, expected, expected],
				agentId,
				accountId: "shared",
			}),
		).toEqual(expected);
	});
});
