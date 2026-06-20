"use client";

import { MessagesSquare, Plus } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { EntityRow } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	CHANNEL_PROVIDERS,
	type ChannelProviderId,
	providerMeta,
} from "@/hosted/channels/channel-providers";
import type { ChannelAccount } from "@/hosted/channels/channel-types";
import { ChannelError, HealthBadge } from "@/hosted/channels/channel-ui";
import { useChannelHealth, useChannels } from "@/hosted/channels/channels-hooks";
import { ConnectBotDialog } from "@/hosted/channels/connect-bot-dialog";
import { SharedBotsPool } from "@/hosted/channels/shared-bots-pool";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Connect Telegram, Discord, WhatsApp, and iMessage to your agents.";

export function ChannelsPage() {
	const [connectOpen, setConnectOpen] = useState(false);

	return (
		<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
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
			<div className="space-y-2">
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-16 w-full rounded-lg" />
				))}
			</div>
		);
	}

	if (channels.error) {
		return (
			<ChannelError
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
		<div className="space-y-4">
			{health.error ? (
				<ChannelError
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

			<div className="space-y-5">
				{groups.map((group) => (
					<div key={group.provider} className="space-y-2">
						{filter === "all" ? (
							<div className="px-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
								{providerMeta(group.provider).label}
							</div>
						) : null}
						<div className="space-y-2">
							{group.items.map((channel) => (
								<ChannelRow
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
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				"rounded-full border px-3 py-1 text-xs font-medium transition-colors",
				active
					? "border-primary bg-primary/10 text-primary"
					: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

function ChannelRow({ channel, health }: { channel: ChannelAccount; health?: string }) {
	const meta = providerMeta(channel.provider);
	return (
		<EntityRow
			href={`/channels/${channel.id}`}
			icon={<EntityIcon kind="channel" id={channel.provider} label={meta.label} />}
			title={channel.name}
			meta={[
				meta.label,
				<span key="status" className="capitalize">
					{channel.status}
				</span>,
			]}
			status={health ? <HealthBadge status={health} /> : undefined}
		/>
	);
}
