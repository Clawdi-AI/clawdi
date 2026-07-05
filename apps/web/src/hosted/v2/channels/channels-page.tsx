"use client";

import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Link2, MessagesSquare, Plus, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	ENTITY_STRETCHED_LINK_CLASS,
	EntityHeader,
} from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { FilterChip } from "@/components/filter-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	CHANNEL_PROVIDERS,
	type ChannelProviderId,
	orderedProviderIds,
	providerMeta,
} from "@/hosted/v2/channels/channel-providers";
import type { ChannelAccount, ChannelBotPoolItem } from "@/hosted/v2/channels/channel-types";
import { AccessBadge, HealthBadge } from "@/hosted/v2/channels/channel-ui";
import { useBotPool, useChannelHealth, useChannels } from "@/hosted/v2/channels/channels-hooks";
import { ConnectBotDialog } from "@/hosted/v2/channels/connect-bot-dialog";
import { LinkAgentDialog } from "@/hosted/v2/channels/link-agent-dialog";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Connect Telegram, Discord, and WhatsApp to your agents.";
const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const CHANNEL_GRID_CLASS = ENTITY_GRID_CLASS;
type ProviderFilter = "all" | ChannelProviderId;

export function ChannelsPage() {
	const [connectOpen, setConnectOpen] = useState(false);
	const [filter, setFilter] = useState<ProviderFilter>("all");
	const channels = useChannels();
	const botPool = useBotPool();
	const health = useChannelHealth();

	const channelItems = channels.data ?? [];
	const poolProviders = botPool.data?.providers ?? {};
	const counts = providerCounts(channelItems, poolProviders);
	const totalCount = CHANNEL_PROVIDERS.reduce((sum, provider) => sum + counts[provider], 0);

	return (
		<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
			<PageHeader title="Channels" description={DESCRIPTION} />

			<ListToolbar
				filters={
					<>
						<FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
							All
							<span className="text-muted-foreground tabular-nums">{totalCount}</span>
						</FilterChip>
						{CHANNEL_PROVIDERS.map((provider) => (
							<FilterChip
								key={provider}
								active={filter === provider}
								onClick={() => setFilter(provider)}
							>
								{providerMeta(provider).label}
								<span className="text-muted-foreground tabular-nums">{counts[provider]}</span>
							</FilterChip>
						))}
					</>
				}
				actions={
					<Button size="sm" onClick={() => setConnectOpen(true)}>
						<Plus />
						Connect a bot
					</Button>
				}
			/>

			<div className="flex flex-col gap-7">
				<YourChannelsSection
					channels={channelItems}
					isLoading={channels.isLoading}
					error={channels.error}
					onRetry={() => channels.refetch()}
					healthItems={health.data?.items ?? []}
					healthError={health.error}
					onRetryHealth={() => health.refetch()}
					filter={filter}
					onConnect={() => setConnectOpen(true)}
				/>
				<SharedBotsSection
					providers={poolProviders}
					isLoading={botPool.isLoading}
					error={botPool.error}
					onRetry={() => botPool.refetch()}
					filter={filter}
				/>
			</div>

			<ConnectBotDialog open={connectOpen} onOpenChange={setConnectOpen} />
		</div>
	);
}

function providerCounts(
	channels: ChannelAccount[],
	poolProviders: Record<string, ChannelBotPoolItem[]>,
): Record<ChannelProviderId, number> {
	const counts = Object.fromEntries(CHANNEL_PROVIDERS.map((p) => [p, 0])) as Record<
		ChannelProviderId,
		number
	>;
	for (const channel of channels) {
		if (isKnownProvider(channel.provider)) counts[channel.provider] += 1;
	}
	for (const provider of CHANNEL_PROVIDERS) {
		counts[provider] += poolProviders[provider]?.length ?? 0;
	}
	return counts;
}

function isKnownProvider(provider: string): provider is ChannelProviderId {
	return (CHANNEL_PROVIDERS as readonly string[]).includes(provider);
}

function providerLabel(filter: ProviderFilter): string {
	return filter === "all" ? "selected providers" : providerMeta(filter).label;
}

function channelGroups(channels: ChannelAccount[], filter: ProviderFilter) {
	const visible = filter === "all" ? channels : channels.filter((c) => c.provider === filter);
	return orderedProviderIds(visible.map((channel) => channel.provider)).map((provider) => ({
		provider,
		items: visible.filter((channel) => channel.provider === provider),
	}));
}

function poolGroups(providers: Record<string, ChannelBotPoolItem[]>, filter: ProviderFilter) {
	const providerIds = filter === "all" ? orderedProviderIds(Object.keys(providers)) : [filter];
	return providerIds
		.map((provider) => ({
			provider,
			items: providers[provider] ?? [],
		}))
		.filter((section) => section.items.length > 0);
}

function YourChannelsSection({
	channels,
	isLoading,
	error,
	onRetry,
	healthItems,
	healthError,
	onRetryHealth,
	filter,
	onConnect,
}: {
	channels: ChannelAccount[];
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
	healthItems: { account_id: string; health_status: string }[];
	healthError: Error | null;
	onRetryHealth: () => void;
	filter: ProviderFilter;
	onConnect: () => void;
}) {
	const groups = channelGroups(channels, filter);
	const visibleCount = groups.reduce((sum, group) => sum + group.items.length, 0);

	let content: ReactNode;

	if (isLoading) {
		content = (
			<div className={CHANNEL_GRID_CLASS}>
				{[0, 1, 2].map((i) => (
					<ChannelCardSkeleton key={i} />
				))}
			</div>
		);
	} else if (error) {
		content = <ApiErrorPanel error={error} onRetry={onRetry} title="Couldn't load channels" />;
	} else if (channels.length === 0) {
		content = (
			<EmptyState
				icon={MessagesSquare}
				title="No channels yet"
				description="Connect a bot, or link a shared bot to an agent from the Shared bots section."
				action={
					<Button onClick={onConnect}>
						<Plus />
						Connect a bot
					</Button>
				}
			/>
		);
	} else if (visibleCount === 0) {
		content = (
			<EmptyState
				icon={MessagesSquare}
				title={`No ${providerLabel(filter)} channels`}
				description="Try another provider filter, or connect a new bot."
				action={
					<Button onClick={onConnect}>
						<Plus />
						Connect a bot
					</Button>
				}
			/>
		);
	} else {
		const healthByAccount = new Map(healthItems.map((h) => [h.account_id, h.health_status]));
		content = (
			<div className="flex flex-col gap-5">
				{groups.map((group) => (
					<ProviderChannelGroup
						key={group.provider}
						provider={group.provider}
						items={group.items}
						healthByAccount={healthByAccount}
					/>
				))}
			</div>
		);
	}

	return (
		<section className="flex flex-col gap-3">
			<SectionLabel count={!isLoading ? visibleCount : undefined}>Your channels</SectionLabel>
			{healthError ? (
				<ApiErrorPanel
					error={healthError}
					onRetry={onRetryHealth}
					title="Couldn't load channel health"
				/>
			) : null}
			{content}
		</section>
	);
}

function ProviderChannelGroup({
	provider,
	items,
	healthByAccount,
}: {
	provider: string;
	items: ChannelAccount[];
	healthByAccount: Map<string, string>;
}) {
	return (
		<div className="flex flex-col gap-2">
			<SectionLabel count={items.length}>{providerMeta(provider).label}</SectionLabel>
			<div className={CHANNEL_GRID_CLASS}>
				{items.map((channel) => (
					<ChannelCard
						key={channel.id}
						channel={channel}
						health={healthByAccount.get(channel.id)}
					/>
				))}
			</div>
		</div>
	);
}

function ChannelCard({ channel, health }: { channel: ChannelAccount; health?: string }) {
	const meta = providerMeta(channel.provider);

	return (
		<div className="group relative z-0 h-full min-w-0">
			<div
				className={cn(
					ENTITY_CARD_BASE,
					"flex h-full items-start gap-3 transition-colors group-hover:bg-muted/50",
				)}
			>
				<EntityHeader
					className="w-full"
					align="start"
					icon={<EntityIcon kind="channel" id={channel.provider} label={meta.label} />}
					title={channel.name}
					titleAdornment={health ? <HealthBadge status={health} /> : undefined}
					meta={[
						meta.label,
						<span key="status" className="capitalize">
							{channel.status}
						</span>,
					]}
				/>
			</div>
			<Link to="/channels/$id" params={{ id: channel.id }} className={ENTITY_STRETCHED_LINK_CLASS}>
				<span className="sr-only">Open {channel.name}</span>
			</Link>
		</div>
	);
}

function ChannelCardSkeleton() {
	return (
		<div className={ENTITY_CARD_BASE}>
			<div className="flex items-start gap-3">
				<Skeleton className="size-10 shrink-0 rounded-lg" />
				<div className="min-w-0 flex-1">
					<Skeleton className="h-4 w-28" />
					<Skeleton className="mt-2 h-3 w-32" />
				</div>
				<Skeleton className="h-6 w-20 rounded-full" />
			</div>
		</div>
	);
}

function SharedBotsSection({
	providers,
	isLoading,
	error,
	onRetry,
	filter,
}: {
	providers: Record<string, ChannelBotPoolItem[]>;
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
	filter: ProviderFilter;
}) {
	const [linkTarget, setLinkTarget] = useState<{ id: string; name: string } | null>(null);
	const groups = poolGroups(providers, filter);
	const visibleCount = groups.reduce((sum, group) => sum + group.items.length, 0);

	let content: ReactNode;
	if (isLoading) {
		content = (
			<div className={CHANNEL_GRID_CLASS}>
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-20 w-full rounded-lg" />
				))}
			</div>
		);
	} else if (error) {
		content = <ApiErrorPanel error={error} onRetry={onRetry} title="Couldn't load shared bots" />;
	} else if (groups.length === 0) {
		content = (
			<EmptyState
				icon={Users}
				title={
					filter === "all" ? "No shared bots available" : `No ${providerLabel(filter)} shared bots`
				}
				description={
					filter === "all"
						? "Shared bots you can link to instantly will appear here."
						: "Try another provider filter to see linkable shared bots."
				}
			/>
		);
	} else {
		content = (
			<div className="flex flex-col gap-5">
				{groups.map((group) => {
					const meta = providerMeta(group.provider);
					return (
						<div key={group.provider} className="flex flex-col gap-2">
							<SectionLabel count={group.items.length}>{meta.label}</SectionLabel>
							<div className={CHANNEL_GRID_CLASS}>
								{group.items.map((item) => (
									<PoolCard
										key={item.id}
										item={item}
										onLink={() => setLinkTarget({ id: item.id, name: item.name })}
									/>
								))}
							</div>
						</div>
					);
				})}
			</div>
		);
	}

	return (
		<section className="flex flex-col gap-3">
			<SectionLabel count={!isLoading ? visibleCount : undefined}>Shared bots</SectionLabel>
			{content}
			{linkTarget ? (
				<LinkAgentDialog
					open={Boolean(linkTarget)}
					onOpenChange={(open) => !open && setLinkTarget(null)}
					accountId={linkTarget.id}
					accountName={linkTarget.name}
				/>
			) : null}
		</section>
	);
}

function PoolCard({ item, onLink }: { item: ChannelBotPoolItem; onLink: () => void }) {
	const owner = item.access === "owner";
	const capacity =
		item.max_links == null
			? `${item.link_count} linked · unlimited`
			: `${item.link_count} of ${item.max_links} linked`;

	const meta = providerMeta(item.provider);
	const linkable = !meta.unavailable && item.available && item.capabilities.link_agent;

	return (
		<div className={cn(ENTITY_CARD_BASE, "flex flex-col gap-3")}>
			<EntityHeader
				align="start"
				icon={<EntityIcon kind="channel" id={item.provider} label={meta.label} />}
				title={item.name}
				titleAdornment={<AccessBadge access={item.access} />}
				meta={
					<span className="inline-flex items-center gap-1.5">
						<Users className="size-3" />
						{capacity}
					</span>
				}
			/>

			{owner ? (
				<Button
					render={<Link to="/channels/$id" params={{ id: item.id }} />}
					nativeButton={false}
					variant="outline"
					size="sm"
					className="w-full"
				>
					Manage
					<ArrowUpRight />
				</Button>
			) : linkable ? (
				<Button size="sm" className="w-full" onClick={onLink}>
					<Link2 />
					Link to an agent
				</Button>
			) : (
				<Button size="sm" variant="outline" className="w-full" disabled>
					{meta.unavailable ? "Unavailable" : item.available ? "Not linkable" : "At capacity"}
				</Button>
			)}
		</div>
	);
}
