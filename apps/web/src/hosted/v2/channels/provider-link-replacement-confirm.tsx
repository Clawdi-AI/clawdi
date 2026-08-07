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
					<>
						This Agent can link only one {providerLabel} bot.{" "}
						{onAddWithoutLinking ? (
							<>
								Add{" "}
								<span className="font-medium text-foreground [overflow-wrap:anywhere]">
									{targetName}
								</span>{" "}
								without linking, or replace the current bot and remove its paired chats.
							</>
						) : (
							<>
								Linking{" "}
								<span className="font-medium text-foreground [overflow-wrap:anywhere]">
									{targetName}
								</span>{" "}
								will replace the current bot and remove its paired chats.
							</>
						)}
					</>
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
