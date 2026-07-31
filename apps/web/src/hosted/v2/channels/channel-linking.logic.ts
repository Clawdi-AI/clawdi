export const WHATSAPP_LINKING_READY = false;

const SINGLE_LINK_PROVIDERS_BY_AGENT_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
	hermes: new Set(["telegram", "discord"]),
	openclaw: new Set(["telegram", "discord"]),
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

export function agentProviderLinkLimitDescription(provider: string): string {
	const label =
		provider === "telegram" ? "Telegram" : provider === "discord" ? "Discord" : provider;
	return `This Agent already has a ${label} bot. Unlink it before connecting another.`;
}

export function pairingCommand(code: string): string {
	return `/bot_pair ${code}`;
}

export function pairingActionLabel(provider: string): string {
	return provider === "discord" ? "Pair Discord" : "Pair chat";
}

export function discordPairingShouldSyncCommands(
	visibility: "private" | "public" | undefined,
): boolean {
	return visibility === "private";
}

export async function prepareProviderPairing<T>({
	provider,
	syncCommands,
	createPairCode,
}: {
	provider: string;
	syncCommands?: () => Promise<unknown>;
	createPairCode: () => Promise<T>;
}): Promise<T> {
	if (provider === "discord" && syncCommands) await syncCommands();
	return createPairCode();
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
