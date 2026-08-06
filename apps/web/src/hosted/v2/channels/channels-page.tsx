"use client";

import { Link } from "@tanstack/react-router";
import { MessagesSquare, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { ENTITY_STRETCHED_LINK_CLASS, EntityCardSkeleton } from "@/components/entity-card";
import { FilterChip } from "@/components/filter-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import {
	CHANNEL_CARD_GRID_CLASS,
	ChannelCard as SharedChannelCard,
} from "@/hosted/v2/channels/channel-card";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import type {
	ChannelAccount,
	ChannelBotPoolItem,
	ChannelHealthItem,
} from "@/hosted/v2/channels/channel-types";
import {
	ChannelStatusBadge,
	HealthBadge,
	isNormalChannelHealth,
	isNormalChannelStatus,
} from "@/hosted/v2/channels/channel-ui";
import {
	useBotPool,
	useChannelHealth,
	useChannels,
	useDeleteChannel,
} from "@/hosted/v2/channels/channels-hooks";
import {
	type ChannelProviderFilter,
	orderedChannelsForFilter,
	providerCounts,
	providersWithBots,
	sharedBotsFromPool,
} from "@/hosted/v2/channels/channels-page.logic";
import { ConnectBotDialog } from "@/hosted/v2/channels/connect-bot-dialog";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Manage Custom bots and discover Clawdi bots for your Agents.";
const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");

export function ChannelsPage() {
	const [connectOpen, setConnectOpen] = useState(false);
	const [filter, setFilter] = useState<ChannelProviderFilter>("all");
	const channels = useChannels();
	const botPool = useBotPool();
	const health = useChannelHealth();

	const channelItems = channels.data ?? [];
	const sharedItems = sharedBotsFromPool(botPool.data?.providers);
	const channelsError = shouldBlockQueryError(channels.error, channels.data)
		? channels.error
		: null;
	const botPoolError = shouldBlockQueryError(botPool.error, botPool.data) ? botPool.error : null;
	const healthError = shouldBlockQueryError(health.error, health.data) ? health.error : null;
	const counts = providerCounts([...channelItems, ...sharedItems]);
	const visibleProviders = providersWithBots(counts);
	const totalCount = channelItems.length + sharedItems.length;
	const inventoryEmpty =
		!channels.isLoading &&
		!botPool.isLoading &&
		!channelsError &&
		!botPoolError &&
		totalCount === 0;

	return (
		<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
			<PageHeader
				title="Channels"
				description={DESCRIPTION}
				actions={
					<Button size="sm" onClick={() => setConnectOpen(true)}>
						<Plus />
						Add channel
					</Button>
				}
			/>

			<ListToolbar
				filters={
					<>
						<FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
							All
							<span className="text-muted-foreground tabular-nums">{totalCount}</span>
						</FilterChip>
						{visibleProviders.map((provider) => (
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
			/>

			{inventoryEmpty ? (
				<EmptyState
					icon={MessagesSquare}
					title="No bots yet"
					description="Add a Custom Telegram, Discord, or WhatsApp account you manage."
				/>
			) : (
				<>
					<OwnedBotsSection
						channels={channelItems}
						isLoading={channels.isLoading}
						error={channelsError}
						onRetry={() => channels.refetch()}
						healthItems={health.data?.items ?? []}
						healthError={healthError}
						onRetryHealth={() => health.refetch()}
						filter={filter}
					/>

					<SharedBotsSection
						bots={sharedItems}
						isLoading={botPool.isLoading}
						error={botPoolError}
						onRetry={() => botPool.refetch()}
						filter={filter}
					/>
				</>
			)}

			<ConnectBotDialog open={connectOpen} onOpenChange={setConnectOpen} />
		</div>
	);
}

function OwnedBotsSection({
	channels,
	isLoading,
	error,
	onRetry,
	healthItems,
	healthError,
	onRetryHealth,
	filter,
}: {
	channels: ChannelAccount[];
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
	healthItems: ChannelHealthItem[];
	healthError: Error | null;
	onRetryHealth: () => void;
	filter: ChannelProviderFilter;
}) {
	const visibleChannels = orderedChannelsForFilter(channels, filter);
	const visibleCount = visibleChannels.length;

	let content: ReactNode;

	if (isLoading) {
		content = (
			<div className={CHANNEL_CARD_GRID_CLASS}>
				{[0, 1, 2].map((i) => (
					<EntityCardSkeleton key={i} trailingBadge />
				))}
			</div>
		);
	} else if (error) {
		content = <ApiErrorPanel error={error} onRetry={onRetry} title="Couldn't load channels" />;
	} else if (visibleCount === 0) {
		return null;
	} else {
		const healthByAccount = new Map(healthItems.map((item) => [item.account_id, item]));
		content = (
			<div className={CHANNEL_CARD_GRID_CLASS}>
				{visibleChannels.map((channel) => (
					<ChannelCard
						key={channel.id}
						channel={channel}
						health={healthByAccount.get(channel.id)}
					/>
				))}
			</div>
		);
	}

	return (
		<section data-owned-bots-section className="flex flex-col gap-3">
			<SectionLabel count={!isLoading ? visibleCount : undefined}>Custom bots</SectionLabel>
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

function SharedBotsSection({
	bots,
	isLoading,
	error,
	onRetry,
	filter,
}: {
	bots: ChannelBotPoolItem[];
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
	filter: ChannelProviderFilter;
}) {
	const visibleBots = orderedChannelsForFilter(bots, filter);
	let content: ReactNode;
	if (isLoading) {
		content = (
			<div className={CHANNEL_CARD_GRID_CLASS}>
				<EntityCardSkeleton trailingBadge />
			</div>
		);
	} else if (error) {
		content = <ApiErrorPanel error={error} onRetry={onRetry} title="Couldn't load Clawdi bots" />;
	} else if (visibleBots.length === 0) {
		return null;
	} else {
		content = (
			<div className={CHANNEL_CARD_GRID_CLASS}>
				{visibleBots.map((bot) => (
					<SharedBotCard key={bot.id} bot={bot} />
				))}
			</div>
		);
	}

	return (
		<section data-shared-bots-section className="flex min-w-0 flex-col gap-3">
			<div>
				<SectionLabel count={!isLoading ? visibleBots.length : undefined}>Clawdi bots</SectionLabel>
				<p className="mt-1 text-xs text-muted-foreground">
					Add them from an Agent&apos;s Channels tab.
				</p>
			</div>
			{content}
		</section>
	);
}

function SharedBotCard({ bot }: { bot: ChannelBotPoolItem }) {
	return (
		<div data-shared-channel-account-id={bot.id} className="h-full min-w-0">
			<SharedChannelCard provider={bot.provider} title={bot.name} />
		</div>
	);
}

function ChannelCard({ channel, health }: { channel: ChannelAccount; health?: ChannelHealthItem }) {
	const del = useDeleteChannel();
	return (
		<div data-channel-account-id={channel.id} className="group relative z-0 h-full min-w-0">
			<SharedChannelCard
				provider={channel.provider}
				title={channel.name}
				className="transition-colors group-hover:bg-muted/50"
				state={[
					health && !isNormalChannelHealth(health.health_status) ? (
						<HealthBadge key="health" health={health} />
					) : null,
					isNormalChannelStatus(channel.status) ? null : (
						<ChannelStatusBadge key="status" status={channel.status} />
					),
				]}
				actions={
					<ConfirmAction
						title={`Delete ${channel.name}?`}
						description="This deletes the Custom bot, its Agent links, and its paired chats. This can't be undone."
						confirmLabel="Delete custom bot"
						destructive
						onConfirm={() => del.mutateAsync({ params: { path: { account_id: channel.id } } })}
					>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="text-muted-foreground hover:text-destructive"
							disabled={del.isPending}
							aria-label={`Delete ${channel.name}`}
						>
							{del.isPending ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" />}
							{del.isPending ? "Deleting…" : "Delete"}
						</Button>
					</ConfirmAction>
				}
			/>
			<Link to="/channels/$id" params={{ id: channel.id }} className={ENTITY_STRETCHED_LINK_CLASS}>
				<span className="sr-only">Open {channel.name}</span>
			</Link>
		</div>
	);
}
