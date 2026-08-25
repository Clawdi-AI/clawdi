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

export type ChannelRuntimeStatus = "connecting" | "connected";

export function channelRuntimeStatus(
	link: Pick<AgentChannelLink, "runtime_status">,
): ChannelRuntimeStatus {
	return link.runtime_status === "connected" ? "connected" : "connecting";
}

export function linkedChannelConnectionSummary(
	links: readonly AgentChannelLink[],
	{ agentStopped = false }: { agentStopped?: boolean } = {},
): string {
	if (links.length === 0) return "No channels linked";
	if (agentStopped) return "Agent stopped";
	const connected = links.filter((link) => channelRuntimeStatus(link) === "connected").length;
	const connecting = links.length - connected;
	if (connecting === 0) return `${connected} connected ${connected === 1 ? "channel" : "channels"}`;
	if (connected === 0)
		return `${connecting} connecting ${connecting === 1 ? "channel" : "channels"}`;
	return `${connected} connected, ${connecting} connecting`;
}

export function normalizeAgentChannelLinks(
	links: readonly AgentChannelLinkPayload[],
): AgentChannelLink[] {
	return links.map((link) => ({
		...link,
		binding_count: link.binding_count ?? 0,
		runtime_status: link.runtime_status ?? "connecting",
	}));
}
