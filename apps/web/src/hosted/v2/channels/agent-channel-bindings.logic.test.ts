import { describe, expect, test } from "bun:test";
import { selectPairedChatsForLink } from "@/hosted/v2/channels/agent-channel-bindings.logic";
import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";

const sharedAccountId = "11111111-1111-4111-8111-111111111111";
const currentLinkId = "22222222-2222-4222-8222-222222222222";
const otherAgentLinkId = "33333333-3333-4333-8333-333333333333";
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
	test("selects one open overlay's active bindings without querying other accounts", () => {
		const items = selectPairedChatsForLink({
			accountId: sharedAccountId,
			agentLinkId: currentLinkId,
			bindings: [
				binding("current", currentLinkId),
				binding("other-link", otherAgentLinkId),
				binding("other-account", currentLinkId, "66666666-6666-4666-8666-666666666666"),
				{ ...binding("archived", currentLinkId), status: "archived" },
			],
			provider: "telegram",
		});

		expect(items.map((item) => item.binding.id)).toEqual(["current"]);
	});
});
