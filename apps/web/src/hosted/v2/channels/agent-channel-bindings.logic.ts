import type { AgentChannelLink } from "@/hosted/v2/channels/channel-edit-client";
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

export function activeAgentChannelLinks(links: readonly AgentChannelLink[]): AgentChannelLink[] {
	return links.filter((link) => link.status.toLowerCase() === "active");
}

export function selectAgentPairedChats({
	visibleLinks,
	bindingsByAccount,
	accountSummaries,
}: {
	visibleLinks: readonly AgentChannelLink[];
	bindingsByAccount: readonly { accountId: string; bindings: readonly ChannelBinding[] }[];
	accountSummaries: ReadonlyMap<string, ChannelAccountSummary>;
}): AgentPairedChatItem[] {
	const activeLinks = activeAgentChannelLinks(visibleLinks);
	const linksById = new Map(activeLinks.map((link) => [link.id, link]));
	const items: AgentPairedChatItem[] = [];

	for (const { accountId, bindings } of bindingsByAccount) {
		for (const binding of bindings) {
			if (!binding.agent_link_id || binding.account_id !== accountId) continue;
			const link = linksById.get(binding.agent_link_id);
			if (!link || link.account_id !== accountId) continue;
			const account = link.account ?? accountSummaries.get(accountId);
			items.push({
				accountId,
				agentLinkId: binding.agent_link_id,
				binding,
				provider: account?.provider ?? "",
			});
		}
	}

	return items;
}
