"use client";

import { Link } from "@tanstack/react-router";
import { MessagesSquare, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_CARD_BUTTON_FOCUS_CLASS,
	ENTITY_GRID_CLASS,
	ENTITY_STRETCHED_LINK_CLASS,
	EntityHeader,
} from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	CHANNEL_PROVIDERS,
	type ChannelProviderId,
	providerMeta,
} from "@/hosted/v2/channels/channel-providers";
import type { ChannelAccount } from "@/hosted/v2/channels/channel-types";
import { HealthBadge } from "@/hosted/v2/channels/channel-ui";
import { useChannelHealth, useChannels } from "@/hosted/v2/channels/channels-hooks";
import { ConnectBotDialog } from "@/hosted/v2/channels/connect-bot-dialog";
import { SharedBotsPool } from "@/hosted/v2/channels/shared-bots-pool";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Connect Telegram, Discord, WhatsApp, and iMessage to your agents.";
const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const CHANNEL_GRID_CLASS = ENTITY_GRID_CLASS;

export function ChannelsPage() {
	const [connectOpen, setConnectOpen] = useState(false);

	return (
		<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
			<PageHeader
				title="Channels"
				description={DESCRIPTION}
				actions={
					<Button onClick={() => setConnectOpen(true)}>
						<Plus />
						Connect a bot
					</Button>
				}
			/>

			<Tabs defaultValue="mine">
				<TabsList>
					<TabsTrigger value="mine">Your channels</TabsTrigger>
					<TabsTrigger value="shared">Shared bots</TabsTrigger>
				</TabsList>
				<TabsContent value="mine" className="mt-4">
					<YourChannels onConnect={() => setConnectOpen(true)} />
				</TabsContent>
				<TabsContent value="shared" className="mt-4">
					<SharedBotsPool />
				</TabsContent>
			</Tabs>

			<ConnectBotDialog open={connectOpen} onOpenChange={setConnectOpen} />
		</div>
	);
}

function YourChannels({ onConnect }: { onConnect: () => void }) {
	const channels = useChannels();
	const health = useChannelHealth();
	const [filter, setFilter] = useState<ChannelProviderId | "all">("all");

	if (channels.isLoading) {
		return (
			<div className={CHANNEL_GRID_CLASS}>
				{[0, 1, 2].map((i) => (
					<ChannelCardSkeleton key={i} />
				))}
			</div>
		);
	}

	if (channels.error) {
		return (
			<ApiErrorPanel
				error={channels.error}
				onRetry={() => channels.refetch()}
				title="Couldn't load channels"
			/>
		);
	}

	const all = channels.data ?? [];
	if (all.length === 0) {
		return (
			<EmptyState
				icon={MessagesSquare}
				title="No channels yet"
				description="Connect a bot, or link a shared bot to an agent from the Shared bots tab."
				action={
					<Button onClick={onConnect}>
						<Plus />
						Connect a bot
					</Button>
				}
			/>
		);
	}

	const healthByAccount = new Map(
		(health.data?.items ?? []).map((h) => [h.account_id, h.health_status]),
	);
	const counts = new Map<string, number>();
	for (const c of all) counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);

	const visible = filter === "all" ? all : all.filter((c) => c.provider === filter);
	const groups = CHANNEL_PROVIDERS.map((p) => ({
		provider: p,
		items: visible.filter((c) => c.provider === p),
	})).filter((g) => g.items.length > 0);

	return (
		<div className="flex flex-col gap-4">
			{health.error ? (
				<ApiErrorPanel
					error={health.error}
					onRetry={() => health.refetch()}
					title="Couldn't load channel health"
				/>
			) : null}
			{/* Provider filter */}
			<div className="flex flex-wrap gap-1.5">
				<FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
					All
					<span className="ml-1 text-muted-foreground">{all.length}</span>
				</FilterChip>
				{CHANNEL_PROVIDERS.filter((p) => counts.has(p)).map((p) => (
					<FilterChip key={p} active={filter === p} onClick={() => setFilter(p)}>
						{providerMeta(p).label}
						<span className="ml-1 text-muted-foreground">{counts.get(p)}</span>
					</FilterChip>
				))}
			</div>

			<div className="flex flex-col gap-5">
				{groups.map((group) => (
					<div key={group.provider} className="flex flex-col gap-2">
						{filter === "all" ? (
							<SectionLabel>{providerMeta(group.provider).label}</SectionLabel>
						) : null}
						<div className={CHANNEL_GRID_CLASS}>
							{group.items.map((channel) => (
								<ChannelCard
									key={channel.id}
									channel={channel}
									health={healthByAccount.get(channel.id)}
								/>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function FilterChip({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				"rounded-full border px-3 py-1 text-xs font-medium transition-colors",
				ENTITY_CARD_BUTTON_FOCUS_CLASS,
				active
					? "border-primary bg-primary/10 text-primary"
					: "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
			)}
		>
			{children}
		</button>
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
