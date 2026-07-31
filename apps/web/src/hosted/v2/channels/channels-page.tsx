"use client";

import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Bot, Link2, MessagesSquare, Plus, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentLabel } from "@/components/dashboard/agent-label";
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
import { IconChip } from "@/components/icon-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { isHostedRuntime } from "@/hosted/runtimes";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";
import { CHANNEL_PROVIDERS, providerMeta } from "@/hosted/v2/channels/channel-providers";
import type {
	ChannelAccount,
	ChannelAgentLink,
	ChannelBotPoolItem,
} from "@/hosted/v2/channels/channel-types";
import {
	ChannelStatusBadge,
	HealthBadge,
	isNormalChannelHealth,
	isNormalChannelStatus,
} from "@/hosted/v2/channels/channel-ui";
import {
	useBotPool,
	useChannelAgentLinks,
	useChannelHealth,
	useChannels,
	useEnvironments,
} from "@/hosted/v2/channels/channels-hooks";
import {
	type ChannelProviderFilter,
	dedupeBotPoolProviders,
	orderedChannelsForFilter,
	orderedPoolItemsForFilter,
	providerCounts,
} from "@/hosted/v2/channels/channels-page.logic";
import { ConnectBotDialog } from "@/hosted/v2/channels/connect-bot-dialog";
import { LinkAgentDialog } from "@/hosted/v2/channels/link-agent-dialog";
import {
	selectCloudAgentCandidates,
	WHATSAPP_LINKING_READY,
} from "@/hosted/v2/channels/link-agent-dialog.logic";
import { useAgentOwnership } from "@/lib/agent-ownership";
import { cn } from "@/lib/utils";

const DESCRIPTION =
	"Start instantly with a ready-to-go bot, or connect your own Telegram or Discord bot for full control.";
const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const CHANNEL_GRID_CLASS = ENTITY_GRID_CLASS;

export function ChannelsPage() {
	const [connectOpen, setConnectOpen] = useState(false);
	const [filter, setFilter] = useState<ChannelProviderFilter>("all");
	const channels = useChannels();
	const botPool = useBotPool();
	const health = useChannelHealth();

	const channelItems = channels.data ?? [];
	const poolProviders = dedupeBotPoolProviders(channelItems, botPool.data?.providers ?? {});
	const counts = providerCounts(channelItems, poolProviders);
	const totalCount =
		channelItems.length +
		Object.values(poolProviders).reduce((sum, items) => sum + items.length, 0);

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
						Connect your own bot
					</Button>
				}
			/>

			<div className="flex flex-col gap-7">
				<ReadyBotsSection
					providers={poolProviders}
					isLoading={botPool.isLoading}
					error={botPool.error}
					onRetry={() => botPool.refetch()}
					filter={filter}
				/>
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
			</div>

			<ConnectBotDialog open={connectOpen} onOpenChange={setConnectOpen} />
		</div>
	);
}

function providerLabel(filter: ChannelProviderFilter): string {
	return filter === "all" ? "selected providers" : providerMeta(filter).label;
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
				title="No personal bots yet"
				description="Personal bots are optional. Use a ready-to-go bot above, or connect one here when you need full control."
				action={
					<Button variant="outline" onClick={onConnect}>
						<Plus />
						Connect your own bot
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
						Connect your own bot
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
		<section data-your-bots-section className="flex flex-col gap-3">
			<SectionLabel count={!isLoading ? visibleCount : undefined}>Your bots</SectionLabel>
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

function ReadyBotsSection({
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
	filter: ChannelProviderFilter;
}) {
	const envs = useEnvironments();
	const ownership = useAgentOwnership();
	const inventory = useHostedDeploymentInventory();
	const [linkTarget, setLinkTarget] = useState<{
		id: string;
		name: string;
		provider: string;
	} | null>(null);
	const visibleItems = orderedPoolItemsForFilter(providers, filter);
	const visibleCount = visibleItems.length;
	const candidateGuardLoading =
		envs.isLoading || ownership === null || inventory.status === "loading";
	const candidateGuardError = envs.error ?? inventory.error;

	let content: ReactNode;
	if (isLoading) {
		content = (
			<div className={CHANNEL_GRID_CLASS}>
				{[0, 1, 2].map((i) => (
					<EntityCardSkeleton key={i} />
				))}
			</div>
		);
	} else if (error) {
		content = (
			<ApiErrorPanel error={error} onRetry={onRetry} title="Couldn't load ready-to-go bots" />
		);
	} else if (visibleItems.length === 0) {
		content = (
			<EmptyState
				icon={Users}
				title={
					filter === "all"
						? "No ready-to-go bots available"
						: `No ${providerLabel(filter)} ready-to-go bots`
				}
				description={
					filter === "all"
						? "Bots you can link without credentials will appear here."
						: "Try another provider filter to see bots you can link instantly."
				}
			/>
		);
	} else {
		content = (
			<div className={CHANNEL_GRID_CLASS}>
				{visibleItems.map((item) => (
					<PoolCard
						key={item.id}
						item={item}
						agents={envs.data ?? []}
						ownership={ownership}
						candidateGuardLoading={candidateGuardLoading}
						candidateGuardError={candidateGuardError}
						onLink={() =>
							setLinkTarget({
								id: item.id,
								name: item.name,
								provider: item.provider,
							})
						}
					/>
				))}
			</div>
		);
	}

	return (
		<section data-ready-bots-section className="flex flex-col gap-3">
			<SectionLabel count={!isLoading ? visibleCount : undefined}>Ready-to-go bots</SectionLabel>
			{visibleItems.length > 0 && candidateGuardError ? (
				<ApiErrorPanel
					error={candidateGuardError}
					onRetry={() => {
						void envs.refetch();
						void inventory.refetch();
					}}
					title="Couldn't verify Cloud Agents"
				/>
			) : null}
			{content}
			{linkTarget ? (
				<LinkAgentDialog
					open={Boolean(linkTarget)}
					onOpenChange={(open) => !open && setLinkTarget(null)}
					accountId={linkTarget.id}
					accountName={linkTarget.name}
					provider={linkTarget.provider}
				/>
			) : null}
		</section>
	);
}

type Environment = NonNullable<ReturnType<typeof useEnvironments>["data"]>[number];

function poolAgentNameFormatter(env: { agent_type?: string | null }) {
	const runtime = env.agent_type;
	return runtime && isHostedRuntime(runtime)
		? (name: string) => deploymentDisplayName(name, runtime)
		: undefined;
}

function PoolAgentRow({ link, env }: { link: ChannelAgentLink; env: Environment | null }) {
	const abnormalStatus = isNormalChannelStatus(link.status) ? undefined : (
		<ChannelStatusBadge status={link.status} />
	);
	if (!env) {
		return (
			<EntityHeader
				className="min-w-0"
				icon={
					<IconChip size="sm">
						<Bot />
					</IconChip>
				}
				title={deploymentDisplayName(link.agent_id)}
				meta={abnormalStatus}
			/>
		);
	}
	return (
		<AgentLabel
			machineName={env.machine_name}
			displayName={env.display_name}
			defaultName={env.default_name}
			type={env.agent_type}
			avatarUrl={env.avatar_url}
			size="sm"
			formatName={poolAgentNameFormatter(env)}
			meta={abnormalStatus ? [abnormalStatus] : undefined}
		/>
	);
}

function PoolCard({
	item,
	onLink,
	agents,
	ownership,
	candidateGuardLoading,
	candidateGuardError,
}: {
	item: ChannelBotPoolItem;
	onLink: () => void;
	agents: readonly Environment[];
	ownership: ReturnType<typeof useAgentOwnership>;
	candidateGuardLoading: boolean;
	candidateGuardError: Error | null;
}) {
	const owner = item.access === "owner";
	const links = useChannelAgentLinks(item.id);
	const ownLinks = links.data ?? [];
	const candidates = selectCloudAgentCandidates(agents, ownership, ownLinks);
	const meta = providerMeta(item.provider);
	const whatsappLinkingGated = item.provider === "whatsapp" && !WHATSAPP_LINKING_READY;
	const linkable =
		!candidateGuardLoading &&
		!candidateGuardError &&
		!links.isLoading &&
		!links.error &&
		candidates.length > 0 &&
		!whatsappLinkingGated &&
		!meta.unavailable &&
		item.available &&
		item.capabilities.link_agent;

	return (
		<div data-pool-account-id={item.id} className={cn(ENTITY_CARD_BASE, "flex flex-col gap-3")}>
			<EntityHeader
				align="start"
				icon={<EntityIcon kind="channel" id={item.provider} label={meta.label} />}
				title={item.name}
			/>

			{links.isLoading ? (
				<div className="space-y-2 border-t pt-3">
					<Skeleton className="h-8 w-full" />
				</div>
			) : links.error ? (
				<ApiErrorPanel
					error={links.error}
					onRetry={() => links.refetch()}
					title="Couldn't load linked agents"
				/>
			) : ownLinks.length > 0 ? (
				<div data-pool-linked-agents className="space-y-2 border-t pt-3">
					{ownLinks.map((link) => (
						<PoolAgentRow
							key={link.id}
							link={link}
							env={agents.find((agent) => agent.id === link.agent_id) ?? null}
						/>
					))}
				</div>
			) : null}

			<div className="flex flex-wrap gap-2">
				{linkable ? (
					<Button size="sm" className="min-w-0 flex-1" onClick={onLink}>
						<Link2 />
						Link an agent
					</Button>
				) : null}
				{owner || ownLinks.length > 0 ? (
					<Button
						render={<Link to="/channels/$id" params={{ id: item.id }} />}
						nativeButton={false}
						variant="outline"
						size="sm"
						className="min-w-0 flex-1"
					>
						Manage
						<ArrowUpRight />
					</Button>
				) : null}
			</div>

			{!owner &&
			ownLinks.length === 0 &&
			!linkable &&
			!candidateGuardLoading &&
			!candidateGuardError &&
			!links.error ? (
				<Button size="sm" variant="outline" className="w-full" disabled>
					{whatsappLinkingGated
						? "Coming soon"
						: meta.unavailable
							? "Unavailable"
							: item.available
								? "Not linkable"
								: "At capacity"}
				</Button>
			) : null}
		</div>
	);
}
