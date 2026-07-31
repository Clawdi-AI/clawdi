"use client";

import { Link } from "@tanstack/react-router";
import { MessagesSquare, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	ENTITY_STRETCHED_LINK_CLASS,
	EntityCardSkeleton,
	EntityHeader,
} from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { FilterChip } from "@/components/filter-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { CHANNEL_PROVIDERS, providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelAccount } from "@/hosted/v2/channels/channel-types";
import {
	ChannelStatusBadge,
	HealthBadge,
	isNormalChannelHealth,
	isNormalChannelStatus,
} from "@/hosted/v2/channels/channel-ui";
import { useChannelHealth, useChannels } from "@/hosted/v2/channels/channels-hooks";
import {
	type ChannelProviderFilter,
	orderedChannelsForFilter,
	providerCounts,
} from "@/hosted/v2/channels/channels-page.logic";
import { ConnectBotDialog } from "@/hosted/v2/channels/connect-bot-dialog";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Manage the bots you own and make available to your Agents.";
const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const CHANNEL_GRID_CLASS = ENTITY_GRID_CLASS;

export function ChannelsPage() {
	const [connectOpen, setConnectOpen] = useState(false);
	const [filter, setFilter] = useState<ChannelProviderFilter>("all");
	const channels = useChannels();
	const health = useChannelHealth();

	const channelItems = channels.data ?? [];
	const counts = providerCounts(channelItems);
	const totalCount = channelItems.length;

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
					<Button size="sm" variant="outline" onClick={() => setConnectOpen(true)}>
						<Plus />
						Connect bot
					</Button>
				}
			/>

			<OwnedBotsSection
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

			<ConnectBotDialog open={connectOpen} onOpenChange={setConnectOpen} />
		</div>
	);
}

function providerLabel(filter: ChannelProviderFilter): string {
	return filter === "all" ? "selected providers" : providerMeta(filter).label;
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
	onConnect,
}: {
	channels: ChannelAccount[];
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
	healthItems: { account_id: string; health_status: string }[];
	healthError: Error | null;
	onRetryHealth: () => void;
	filter: ChannelProviderFilter;
	onConnect: () => void;
}) {
	const visibleChannels = orderedChannelsForFilter(channels, filter);
	const visibleCount = visibleChannels.length;

	let content: ReactNode;

	if (isLoading) {
		content = (
			<div className={CHANNEL_GRID_CLASS}>
				{[0, 1, 2].map((i) => (
					<EntityCardSkeleton key={i} trailingBadge />
				))}
			</div>
		);
	} else if (error) {
		content = <ApiErrorPanel error={error} onRetry={onRetry} title="Couldn't load channels" />;
	} else if (channels.length === 0) {
		content = (
			<EmptyState
				icon={MessagesSquare}
				title="No bots yet"
				description="Connect a Telegram or Discord bot to make it available to your Agents."
				action={
					<Button variant="outline" onClick={onConnect}>
						<Plus />
						Connect bot
					</Button>
				}
			/>
		);
	} else if (visibleCount === 0) {
		content = (
			<EmptyState
				icon={MessagesSquare}
				title={`No ${providerLabel(filter)} channels`}
				description="Try another provider filter, or connect your own bot."
				action={
					<Button variant="outline" onClick={onConnect}>
						<Plus />
						Connect bot
					</Button>
				}
			/>
		);
	} else {
		const healthByAccount = new Map(healthItems.map((h) => [h.account_id, h.health_status]));
		content = (
			<div className={CHANNEL_GRID_CLASS}>
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
			<SectionLabel count={!isLoading ? visibleCount : undefined}>Bots</SectionLabel>
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

function ChannelCard({ channel, health }: { channel: ChannelAccount; health?: string }) {
	const meta = providerMeta(channel.provider);

	return (
		<div data-channel-account-id={channel.id} className="group relative z-0 h-full min-w-0">
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
					titleAdornment={
						health && !isNormalChannelHealth(health) ? <HealthBadge status={health} /> : undefined
					}
					meta={
						isNormalChannelStatus(channel.status) ? undefined : (
							<ChannelStatusBadge status={channel.status} />
						)
					}
				/>
			</div>
			<Link to="/channels/$id" params={{ id: channel.id }} className={ENTITY_STRETCHED_LINK_CLASS}>
				<span className="sr-only">Open {channel.name}</span>
			</Link>
		</div>
	);
}
