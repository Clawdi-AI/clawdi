import type { components } from "@clawdi/shared/api";

type GeneratedAgentChannelLink = components["schemas"]["ChannelAgentLinkWithAccountResponse"];
type AgentChannelLinkPayload = Omit<GeneratedAgentChannelLink, "binding_count"> & {
	binding_count?: number;
};

export type AgentChannelLink = Omit<GeneratedAgentChannelLink, "account"> & {
	account?: components["schemas"]["ChannelAccountResponse"] | null;
};

export function normalizeAgentChannelLinks(
	links: readonly AgentChannelLinkPayload[],
): AgentChannelLink[] {
	return links.map((link) => ({ ...link, binding_count: link.binding_count ?? 0 }));
}
