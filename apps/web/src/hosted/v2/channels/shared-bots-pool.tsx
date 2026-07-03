"use client";

import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Link2, Users } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { ENTITY_CARD_BASE, ENTITY_GRID_CLASS, EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CHANNEL_PROVIDERS, providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelBotPoolItem } from "@/hosted/v2/channels/channel-types";
import { AccessBadge } from "@/hosted/v2/channels/channel-ui";
import { useBotPool } from "@/hosted/v2/channels/channels-hooks";
import { LinkAgentDialog } from "@/hosted/v2/channels/link-agent-dialog";
import { cn } from "@/lib/utils";

const BOT_GRID_CLASS = ENTITY_GRID_CLASS;

/**
 * Shared bot pool — public bots the user can link an agent to instantly (no
 * token), plus their own bots. Grouped by provider; at-capacity bots are
 * shown but disabled.
 */
export function SharedBotsPool() {
	const pool = useBotPool();
	const [linkTarget, setLinkTarget] = useState<{ id: string; name: string } | null>(null);

	if (pool.isLoading) {
		return (
			<div data-hosted="true" data-v2="true" className={BOT_GRID_CLASS}>
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-20 w-full rounded-lg" />
				))}
			</div>
		);
	}

	if (pool.error) {
		return (
			<div data-hosted="true" data-v2="true">
				<ApiErrorPanel
					error={pool.error}
					onRetry={() => pool.refetch()}
					title="Couldn't load shared bots"
				/>
			</div>
		);
	}

	const providers = pool.data?.providers ?? {};
	const sections = CHANNEL_PROVIDERS.map((p) => ({
		provider: p,
		items: providers[p] ?? [],
	})).filter((s) => s.items.length > 0);

	if (sections.length === 0) {
		return (
			<div data-hosted="true" data-v2="true">
				<EmptyState
					icon={Users}
					title="No shared bots available"
					description="Shared bots you can link to instantly will appear here."
				/>
			</div>
		);
	}

	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-6">
			{sections.map((section) => {
				const meta = providerMeta(section.provider);
				return (
					<div key={section.provider} className="flex flex-col gap-2">
						<SectionLabel count={section.items.length}>{meta.label}</SectionLabel>
						<div className={BOT_GRID_CLASS}>
							{section.items.map((item) => (
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

			{linkTarget ? (
				<LinkAgentDialog
					open={Boolean(linkTarget)}
					onOpenChange={(o) => !o && setLinkTarget(null)}
					accountId={linkTarget.id}
					accountName={linkTarget.name}
				/>
			) : null}
		</div>
	);
}

function PoolCard({ item, onLink }: { item: ChannelBotPoolItem; onLink: () => void }) {
	const owner = item.access === "owner";
	const capacity =
		item.max_links == null
			? `${item.link_count} linked · unlimited`
			: `${item.link_count} of ${item.max_links} linked`;

	const meta = providerMeta(item.provider);
	const linkable = item.available && item.capabilities.link_agent;

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
				<Button asChild variant="outline" size="sm" className="w-full">
					<Link to="/channels/$id" params={{ id: item.id }}>
						Manage
						<ArrowUpRight className="size-3.5" />
					</Link>
				</Button>
			) : linkable ? (
				<Button size="sm" className="w-full" onClick={onLink}>
					<Link2 className="size-3.5" />
					Link to an agent
				</Button>
			) : (
				<Button size="sm" variant="outline" className="w-full" disabled>
					{/* `available` false = genuinely full; otherwise the bot just
					    isn't linkable (capability-gated) — don't mislabel as capacity. */}
					{item.available ? "Not linkable" : "At capacity"}
				</Button>
			)}
		</div>
	);
}
