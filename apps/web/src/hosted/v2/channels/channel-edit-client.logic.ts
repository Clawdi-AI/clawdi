import type { components } from "@clawdi/shared/api";

type GeneratedAgentChannelLink = components["schemas"]["ChannelAgentLinkWithAccountResponse"];
type AgentChannelLinkPayload = Omit<
	GeneratedAgentChannelLink,
	"binding_count" | "runtime_status"
> & {
	binding_count?: number;
	runtime_status?: GeneratedAgentChannelLink["runtime_status"];
};

export type AgentChannelLink = Omit<GeneratedAgentChannelLink, "account"> & {
	account?: components["schemas"]["ChannelAccountResponse"] | null;
};

export function normalizeAgentChannelLinks(
	links: readonly AgentChannelLinkPayload[],
): AgentChannelLink[] {
	return links.map((link) => ({
		...link,
		binding_count: link.binding_count ?? 0,
		runtime_status: link.runtime_status ?? "connecting",
	}));
}
