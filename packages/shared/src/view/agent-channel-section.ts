import { agentProviderLinkStatusUnknown, type HostedDeployRuntime as HostedRuntime } from "../api";
import type { AgentChannelCardItem } from "./agent-channel-cards";
export const agentChannelSectionCopy = {
	clawdiDescription: "Clawdi-managed bots available to your account.",
	customDescription: "Bots and WhatsApp accounts whose connection you manage.",
	clawdiEmpty: "No Clawdi bots available",
	customEmpty: "No custom bots yet",
	description: "Channels linked to this agent.",
	available: "Available",
	pair: "Pair",
	generating: "Generating…",
	link: "Link",
	linking: "Linking…",
	unlink: "Unlink",
	unlinking: "Unlinking…",
} as const;

export function agentChannelUnlinkCopy(botName: string, agentName: string) {
	return {
		title: `Unlink ${botName}?`,
		description: `${agentName} will stop answering through this bot.`,
	};
}

export function agentChannelLinkUnavailableReason({
	bot,
	agentType,
	linkedProviders,
}: {
	bot: AgentChannelCardItem;
	agentType: HostedRuntime;
	linkedProviders: ReadonlySet<string> | undefined;
}): string | null {
	if (!bot.available || !bot.canLink || bot.status.toLowerCase() !== "active") {
		return bot.maxLinks !== null ? "At capacity" : "Unavailable";
	}
	if (agentProviderLinkStatusUnknown(agentType, bot.provider, linkedProviders)) {
		return "Agent link status unavailable";
	}
	return null;
}

export function agentChannelPairedChatsLabel(count: number): string {
	return `${count} paired ${count === 1 ? "chat" : "chats"}`;
}
