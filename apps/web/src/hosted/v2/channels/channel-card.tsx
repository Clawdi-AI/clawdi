"use client";

import type { ReactNode } from "react";
import { ENTITY_CARD_BASE, ENTITY_GRID_CLASS, EntityHeader } from "@/components/entity-card";
import { ProviderChip } from "@/hosted/v2/channels/channel-ui";
import { cn } from "@/lib/utils";

/** Channel cards in the same grid row share a stable outer height. */
export const CHANNEL_CARD_GRID_CLASS = cn(ENTITY_GRID_CLASS, "items-stretch xl:grid-cols-2");

/**
 * Shared visual shell for bot inventory and Agent channel cards. Provider
 * identity and responsive header layout live here; navigation, mutations, and
 * nested chat content remain composed by each surface.
 */
export function ChannelCard({
	provider,
	title,
	state,
	actions,
	children,
	className,
	headerClassName,
}: {
	provider: string;
	title: ReactNode;
	state?: ReactNode | ReactNode[];
	actions?: ReactNode;
	children?: ReactNode;
	className?: string;
	headerClassName?: string;
}) {
	return (
		<article
			data-hosted="true"
			data-v2="true"
			className={cn(ENTITY_CARD_BASE, "flex h-full flex-col overflow-hidden p-0", className)}
		>
			<div
				data-channel-card-header
				className={cn(
					"grid min-h-20 min-w-0 flex-1 content-center gap-3 p-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center",
					headerClassName,
				)}
			>
				<EntityHeader
					align="start"
					icon={<ProviderChip provider={provider} />}
					title={title}
					titleAttribute={typeof title === "string" ? title : undefined}
					meta={state}
				/>
				{actions ? (
					<div data-channel-card-actions className="flex min-w-0 items-center justify-end gap-2">
						{actions}
					</div>
				) : null}
			</div>
			{children ? (
				<div data-channel-card-footer className="shrink-0 border-t">
					{children}
				</div>
			) : null}
		</article>
	);
}
