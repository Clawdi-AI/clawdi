"use client";
import { channelCardClasses as styles } from "@clawdi/shared/ui";

import type { ReactNode } from "react";
import { ENTITY_CARD_BASE, ENTITY_GRID_CLASS, EntityHeader } from "@/components/entity-card";
import { ProviderChip } from "@/hosted/v2/channels/channel-ui";
import { cn } from "@/lib/utils";

/** Channel cards in the same grid row share a stable outer height. */
export const CHANNEL_CARD_GRID_CLASS = cn(ENTITY_GRID_CLASS, styles.grid);

/**
 * Shared visual shell for bot inventory and Agent channel cards. Provider
 * identity and responsive header layout live here; navigation, mutations, and
 * status metadata remain composed by each surface.
 */
export function ChannelCard({
	provider,
	title,
	state,
	actions,
	className,
	headerClassName,
}: {
	provider: string;
	title: ReactNode;
	state?: ReactNode | ReactNode[];
	actions?: ReactNode;
	className?: string;
	headerClassName?: string;
}) {
	return (
		<article
			data-hosted="true"
			data-v2="true"
			className={cn(ENTITY_CARD_BASE, styles.card, className)}
		>
			<div data-channel-card-header className={cn(styles.header, headerClassName)}>
				<EntityHeader
					align="start"
					icon={<ProviderChip provider={provider} />}
					title={title}
					titleAttribute={typeof title === "string" ? title : undefined}
					meta={state}
				/>
				{actions ? (
					<div data-channel-card-actions className={styles.actions}>
						{actions}
					</div>
				) : null}
			</div>
		</article>
	);
}
