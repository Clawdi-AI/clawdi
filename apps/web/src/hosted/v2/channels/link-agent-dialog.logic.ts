import type { components } from "@clawdi/shared/api";

type Agent = Pick<components["schemas"]["AgentResponse"], "agent_type"> | null | undefined;
type AgentChannelLink = {
	account_id: string;
	status: string;
	account: {
		provider: string;
	};
};

export const HERMES_WHATSAPP_UNSUPPORTED_MESSAGE =
	"WhatsApp for Hermes agents is coming soon - pending an upstream Hermes release.";

const HERMES_SINGLE_LINK_PROVIDERS = new Set(["telegram", "discord"]);

export function shouldMintWhatsappTenantCredential(provider: string, agent: Agent): boolean {
	return (
		provider === "whatsapp" &&
		agent !== null &&
		agent !== undefined &&
		agent.agent_type !== "hermes"
	);
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
	if (selectedAgent?.agent_type !== "hermes") return null;
	if (provider === "whatsapp") return HERMES_WHATSAPP_UNSUPPORTED_MESSAGE;
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
