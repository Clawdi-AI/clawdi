"use client";

import type { ReactElement } from "react";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";

export function ProviderLinkReplacementConfirm({
	provider,
	targetName,
	onAddWithoutLinking,
	onConfirm,
	children,
}: {
	provider: string;
	targetName: string;
	onAddWithoutLinking?: () => unknown;
	onConfirm: () => unknown;
	children: ReactElement;
}) {
	const providerLabel = providerMeta(provider).label;
	return (
		<div data-hosted="true" data-v2="true" className="contents">
			<ConfirmAction
				title={
					onAddWithoutLinking
						? `How should this ${providerLabel} bot be added?`
						: `Replace this Agent’s ${providerLabel} link?`
				}
				description={
					onAddWithoutLinking ? (
						<>
							This Agent can use one {providerLabel} bot at a time. Choose Add without linking to
							keep the current bot and its paired chats;{" "}
							<span className="font-medium text-foreground [overflow-wrap:anywhere]">
								{targetName}
							</span>{" "}
							will be added to Custom bots only. Choose Replace to link the new bot and remove the
							current bot&apos;s paired chats from this Agent.
						</>
					) : (
						<>
							This Agent can use one {providerLabel} bot at a time.{" "}
							<span className="font-medium text-foreground [overflow-wrap:anywhere]">
								{targetName}
							</span>{" "}
							will replace the current bot, and its paired chats will be removed from this Agent.
						</>
					)
				}
				confirmLabel={`Replace ${providerLabel} link`}
				secondaryAction={
					onAddWithoutLinking
						? { label: "Add without linking", onAction: onAddWithoutLinking }
						: undefined
				}
				destructive
				onConfirm={onConfirm}
			>
				{children}
			</ConfirmAction>
		</div>
	);
}
