import type { AgentChannelLink } from "@/hosted/v2/channels/channel-edit-client.logic";
import { orderedProviderIds } from "@/hosted/v2/channels/channel-providers";
import type { ChannelAccount, ChannelBotPoolItem } from "@/hosted/v2/channels/channel-types";

export type AgentChannelCardItem = {
	id: string;
	provider: string;
	name: string;
	status: string;
	visibility: "private" | "public";
	available: boolean;
	canLink: boolean;
	maxLinks: number | null;
	link: AgentChannelLink | null;
};

export type AgentChannelCardGroups = {
	clawdiBots: AgentChannelCardItem[];
	customBots: AgentChannelCardItem[];
};

function activeLink(link: AgentChannelLink, agentId: string): boolean {
	return link.agent_id === agentId && link.status.toLowerCase() === "active";
}

function newerLink(candidate: AgentChannelLink, current: AgentChannelLink): boolean {
	const candidateCreatedAt = Date.parse(candidate.created_at);
	const currentCreatedAt = Date.parse(current.created_at);
	if (Number.isFinite(candidateCreatedAt) && Number.isFinite(currentCreatedAt)) {
		if (candidateCreatedAt !== currentCreatedAt) return candidateCreatedAt > currentCreatedAt;
	}
	return candidate.id.localeCompare(current.id) > 0;
}

/**
 * The API invariant is one active link per (account, Agent), but old/stale
 * payloads may contain duplicates. Keep exactly one deterministic link per bot
 * and prefer the just-created link while its list query catches up.
 */
export function canonicalAgentChannelLinks({
	links,
	agentId,
	recentLinks = [],
}: {
	links: readonly AgentChannelLink[];
	agentId: string;
	recentLinks?: readonly AgentChannelLink[];
}): AgentChannelLink[] {
	const byAccount = new Map<string, AgentChannelLink>();
	const preferredIds = new Map(
		recentLinks
			.filter((link) => activeLink(link, agentId))
			.map((link) => [link.account_id, link.id]),
	);
	const candidates = [...recentLinks, ...links];
	for (const link of candidates) {
		if (!activeLink(link, agentId)) continue;
		const current = byAccount.get(link.account_id);
		const preferredId = preferredIds.get(link.account_id);
		if (
			!current ||
			link.id === preferredId ||
			(current.id !== preferredId && newerLink(link, current))
		) {
			byAccount.set(link.account_id, link);
		}
	}
	return Array.from(byAccount.values());
}

export function activeAgentLinkForAccount({
	links,
	agentId,
	accountId,
}: {
	links: readonly AgentChannelLink[];
	agentId: string;
	accountId: string;
}): AgentChannelLink | null {
	return (
		canonicalAgentChannelLinks({ links, agentId }).find((link) => link.account_id === accountId) ??
		null
	);
}

/** Resolve active-link providers from the embedded account first, then inventory fallbacks. */
export function activeLinkedProviders({
	links,
	channels = [],
	poolProviders,
}: {
	links: readonly AgentChannelLink[];
	channels?: readonly ChannelAccount[];
	poolProviders?: Readonly<Record<string, readonly ChannelBotPoolItem[]>>;
}): ReadonlySet<string> | null {
	const providerByAccountId = new Map(channels.map((account) => [account.id, account.provider]));
	for (const providerBots of Object.values(poolProviders ?? {})) {
		for (const bot of providerBots) providerByAccountId.set(bot.id, bot.provider);
	}

	const providers = new Set<string>();
	for (const link of links) {
		if (link.status.toLowerCase() !== "active") continue;
		const provider = link.account?.provider ?? providerByAccountId.get(link.account_id);
		if (!provider) return null;
		providers.add(provider);
	}
	return providers;
}

type MutableCard = AgentChannelCardItem & {
	createdAt: string;
	poolPriority: boolean;
};

function fallbackCardFromLink(link: AgentChannelLink): MutableCard {
	return {
		id: link.account_id,
		provider: "",
		name: "Unnamed bot",
		status: link.status,
		visibility: "private",
		available: true,
		canLink: true,
		maxLinks: null,
		createdAt: link.created_at,
		link,
		poolPriority: false,
	};
}

function cardFromAccount(account: ChannelAccount, link: AgentChannelLink | null): MutableCard {
	return {
		id: account.id,
		provider: account.provider,
		name: account.name,
		status: account.status,
		visibility: account.visibility,
		available: account.status.toLowerCase() === "active",
		canLink: account.status.toLowerCase() === "active",
		maxLinks: null,
		createdAt: account.created_at,
		link,
		poolPriority: false,
	};
}

function cardFromPool(bot: ChannelBotPoolItem, link: AgentChannelLink | null): MutableCard {
	return {
		id: bot.id,
		provider: bot.provider,
		name: bot.name,
		status: bot.status,
		visibility: bot.visibility,
		available: bot.available,
		canLink: bot.capabilities.link_agent,
		maxLinks: bot.max_links ?? null,
		createdAt: bot.created_at,
		link,
		poolPriority: true,
	};
}

function compareCards(
	left: MutableCard,
	right: MutableCard,
	providerRanks: ReadonlyMap<string, number>,
): number {
	const leftCreatedAt = Date.parse(left.createdAt);
	const rightCreatedAt = Date.parse(right.createdAt);
	const createdAtOrder =
		Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt)
			? leftCreatedAt - rightCreatedAt
			: left.createdAt.localeCompare(right.createdAt);
	return (
		(providerRanks.get(left.provider) ?? Number.MAX_SAFE_INTEGER) -
			(providerRanks.get(right.provider) ?? Number.MAX_SAFE_INTEGER) ||
		createdAtOrder ||
		left.id.localeCompare(right.id)
	);
}

function cardItem({ createdAt: _createdAt, poolPriority: _poolPriority, ...card }: MutableCard) {
	return card;
}

/** Build the two Agent-page inventories while deduplicating every source by bot id. */
export function buildAgentChannelCardGroups({
	channels,
	poolProviders,
	links,
}: {
	channels: readonly ChannelAccount[];
	poolProviders: Readonly<Record<string, readonly ChannelBotPoolItem[]>> | undefined;
	links: readonly AgentChannelLink[];
}): AgentChannelCardGroups {
	const linksByAccount = new Map(links.map((link) => [link.account_id, link]));
	const cards = new Map<string, MutableCard>();

	for (const link of links) {
		cards.set(
			link.account_id,
			link.account ? cardFromAccount(link.account, link) : fallbackCardFromLink(link),
		);
	}
	for (const channel of channels) {
		const existing = cards.get(channel.id);
		cards.set(channel.id, cardFromAccount(channel, linksByAccount.get(channel.id) ?? null));
		if (existing?.poolPriority) cards.set(channel.id, existing);
	}
	for (const providerBots of Object.values(poolProviders ?? {})) {
		for (const bot of providerBots) {
			cards.set(bot.id, cardFromPool(bot, linksByAccount.get(bot.id) ?? null));
		}
	}

	const clawdiBots: MutableCard[] = [];
	const customBots: MutableCard[] = [];
	for (const card of cards.values()) {
		if (card.visibility === "public") clawdiBots.push(card);
		else customBots.push(card);
	}
	const providerRanks = new Map(
		orderedProviderIds(Array.from(cards.values(), (card) => card.provider)).map(
			(provider, index) => [provider, index],
		),
	);
	const compare = (left: MutableCard, right: MutableCard) =>
		compareCards(left, right, providerRanks);
	clawdiBots.sort(compare);
	customBots.sort(compare);
	return { clawdiBots: clawdiBots.map(cardItem), customBots: customBots.map(cardItem) };
}
