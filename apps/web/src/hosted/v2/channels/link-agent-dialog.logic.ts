import type { components } from "@clawdi/shared/api";

type Agent = Pick<components["schemas"]["AgentResponse"], "agent_type"> | null | undefined;
type AgentChannelLink = {
	account_id: string;
	status: string;
	account: {
		provider: string;
	};
};

export const WHATSAPP_LINKING_READY = false;
export const WHATSAPP_COMING_SOON_MESSAGE =
	"WhatsApp channels are coming soon for hosted agents. Telegram and Discord are available now.";

const HERMES_SINGLE_LINK_PROVIDERS = new Set(["telegram", "discord"]);

export function channelProviderLinkingReady(provider: string): boolean {
	return provider !== "whatsapp" || WHATSAPP_LINKING_READY;
}

export function pairingCommand(code: string): string {
	return `/bot_pair ${code}`;
}

export function shouldMintWhatsappTenantCredential(provider: string, agent: Agent): boolean {
	return WHATSAPP_LINKING_READY && provider === "whatsapp" && agent !== null && agent !== undefined;
}

export function linkAgentBlockReason({
	provider,
	selectedAgent,
	existingAgentLinks,
	accountId,
}: {
	provider: string;
	selectedAgent: Agent;
	existingAgentLinks: AgentChannelLink[];
	accountId: string;
}): string | null {
	if (!channelProviderLinkingReady(provider)) return WHATSAPP_COMING_SOON_MESSAGE;
	if (selectedAgent?.agent_type !== "hermes") return null;
	if (!HERMES_SINGLE_LINK_PROVIDERS.has(provider)) return null;

	const hasExistingProviderLink = existingAgentLinks.some(
		(link) =>
			link.status === "active" &&
			link.account_id !== accountId &&
			link.account.provider === provider,
	);
	if (!hasExistingProviderLink) return null;
	return `one-${provider}-link-per-Hermes-agent: Hermes agents support one active ${provider} link. Unlink the existing ${provider} channel before linking another.`;
}
