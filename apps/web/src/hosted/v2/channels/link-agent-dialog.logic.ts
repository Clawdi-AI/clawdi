import type { components } from "@clawdi/shared/api";
import { type AgentOwnership, agentOwnershipKindFromId } from "@/lib/agent-ownership";

type Agent = Pick<components["schemas"]["AgentResponse"], "id" | "agent_type">;
type SelectedAgent = Pick<components["schemas"]["AgentResponse"], "agent_type"> | null | undefined;
type AccountAgentLink = { agent_id: string };
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

const SINGLE_LINK_PROVIDERS_BY_AGENT_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
	hermes: new Set(["telegram", "discord"]),
	openclaw: new Set(["telegram"]),
};
const AGENT_TYPE_LABELS: Readonly<Record<string, string>> = {
	hermes: "Hermes",
	openclaw: "OpenClaw",
};

export function channelProviderLinkingReady(provider: string): boolean {
	return provider !== "whatsapp" || WHATSAPP_LINKING_READY;
}

export function agentProviderHasSingleLinkLimit(
	agentType: string | null | undefined,
	provider: string,
): boolean {
	return Boolean(agentType && SINGLE_LINK_PROVIDERS_BY_AGENT_TYPE[agentType]?.has(provider));
}

/** Cloud membership is authoritative; connected, legacy, and unresolved ids fail closed. */
export function selectCloudAgentCandidates<T extends Agent>(
	agents: readonly T[],
	ownership: AgentOwnership | null,
	accountLinks: readonly AccountAgentLink[],
): T[] {
	const linkedAgentIds = new Set(accountLinks.map((link) => link.agent_id.toLowerCase()));
	return agents.filter(
		(agent) =>
			agentOwnershipKindFromId(agent.id, ownership) === "cloud" &&
			!linkedAgentIds.has(agent.id.toLowerCase()),
	);
}

export function pairingCommand(code: string): string {
	return `/bot_pair ${code}`;
}

export function pairCodeExpired(expiresAt: string, nowMs: number): boolean {
	const expiresAtMs = Date.parse(expiresAt);
	return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

/** Account-level activity is useful, but it is not proof of agent-runtime delivery. */
export function channelActivityAfterLink(
	lastMessageAt: string | null | undefined,
	linkCreatedAt: string,
): boolean {
	if (!lastMessageAt) return false;
	const messageTime = Date.parse(lastMessageAt);
	const linkTime = Date.parse(linkCreatedAt);
	return Number.isFinite(messageTime) && Number.isFinite(linkTime) && messageTime >= linkTime;
}

export function shouldMintWhatsappTenantCredential(
	provider: string,
	agent: SelectedAgent,
): boolean {
	return WHATSAPP_LINKING_READY && provider === "whatsapp" && agent !== null && agent !== undefined;
}

export function linkAgentBlockReason({
	provider,
	selectedAgent,
	existingAgentLinks,
	accountId,
}: {
	provider: string;
	selectedAgent: SelectedAgent;
	existingAgentLinks: AgentChannelLink[];
	accountId: string;
}): string | null {
	if (!channelProviderLinkingReady(provider)) return WHATSAPP_COMING_SOON_MESSAGE;
	const agentType = selectedAgent?.agent_type;
	if (!agentType || !agentProviderHasSingleLinkLimit(agentType, provider)) return null;

	const hasExistingProviderLink = existingAgentLinks.some(
		(link) =>
			link.status === "active" &&
			link.account_id !== accountId &&
			link.account.provider === provider,
	);
	if (!hasExistingProviderLink) return null;
	return `${AGENT_TYPE_LABELS[agentType] ?? agentType} agents can use one active ${providerMetaLabel(provider)} bot at a time. Unlink the current ${providerMetaLabel(provider)} bot before linking another.`;
}

function providerMetaLabel(provider: string): string {
	return provider === "telegram" ? "Telegram" : provider === "discord" ? "Discord" : "channel";
}
