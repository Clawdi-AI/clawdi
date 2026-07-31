import { describe, expect, test } from "bun:test";
import {
	activeAgentChannelLinks,
	selectAgentPairedChats,
} from "@/hosted/v2/channels/agent-channel-bindings.logic";
import type { AgentChannelLink } from "@/hosted/v2/channels/channel-edit-client";
import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";

const sharedAccountId = "11111111-1111-4111-8111-111111111111";
const currentLinkId = "22222222-2222-4222-8222-222222222222";
const otherAgentLinkId = "33333333-3333-4333-8333-333333333333";
const archivedLinkId = "44444444-4444-4444-8444-444444444444";

function link(id: string, status = "active"): AgentChannelLink {
	return {
		id,
		account_id: sharedAccountId,
		agent_id: "55555555-5555-4555-8555-555555555555",
		status,
		created_at: "2026-07-31T00:00:00Z",
	};
}

function binding(
	id: string,
	agentLinkId: string | null,
	accountId = sharedAccountId,
): ChannelBinding {
	return {
		id,
		account_id: accountId,
		agent_link_id: agentLinkId,
		external_chat_id: id,
		external_chat_type: "private",
		external_chat_name: `Chat ${id}`,
		status: "active",
		created_at: "2026-07-31T00:05:00Z",
	};
}

describe("Agent paired chat selection", () => {
	test("keeps only bindings owned by visible active links on the queried account", () => {
		const current = link(currentLinkId);
		const archived = link(archivedLinkId, "archived");
		const items = selectAgentPairedChats({
			visibleLinks: [current, archived],
			bindingsByAccount: [
				{
					accountId: sharedAccountId,
					bindings: [
						binding("current", currentLinkId),
						binding("other-agent", otherAgentLinkId),
						binding("archived", archivedLinkId),
						binding("unowned", null),
						binding("wrong-account", currentLinkId, "66666666-6666-4666-8666-666666666666"),
					],
				},
			],
			accountSummaries: new Map([
				[sharedAccountId, { provider: "telegram", name: "Shared Telegram" }],
			]),
		});

		expect(items.map((item) => item.binding.id)).toEqual(["current"]);
		expect(items[0]).toMatchObject({
			accountId: sharedAccountId,
			agentLinkId: currentLinkId,
			provider: "telegram",
		});
	});

	test("identifies active links without treating archived links as pairing owners", () => {
		expect(
			activeAgentChannelLinks([link(currentLinkId), link(archivedLinkId, "archived")]),
		).toEqual([link(currentLinkId)]);
	});
});
