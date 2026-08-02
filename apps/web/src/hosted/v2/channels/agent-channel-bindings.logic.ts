import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";

export type ChannelAccountSummary = {
	provider: string;
	name: string;
	visibility?: "private" | "public";
};

export type AgentPairedChatItem = {
	accountId: string;
	agentLinkId: string;
	binding: ChannelBinding;
	provider: string;
};

export function selectPairedChatsForLink({
	accountId,
	agentLinkId,
	bindings,
	provider,
}: {
	accountId: string;
	agentLinkId: string;
	bindings: readonly ChannelBinding[];
	provider: string;
}): AgentPairedChatItem[] {
	return bindings
		.filter(
			(binding) =>
				binding.account_id === accountId &&
				binding.agent_link_id === agentLinkId &&
				binding.status.toLowerCase() === "active",
		)
		.map((binding) => ({ accountId, agentLinkId, binding, provider }));
}
