export const WHATSAPP_LINKING_READY = false;

const SINGLE_LINK_PROVIDERS_BY_AGENT_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
	hermes: new Set(["telegram", "discord"]),
	openclaw: new Set(["telegram"]),
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
