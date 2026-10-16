"use client";

import { providerLinkReplacementCopy } from "@clawdi/shared/view";
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
	const replacement = providerLinkReplacementCopy(providerLabel);
	return (
		<div data-hosted="true" data-v2="true" className="contents">
			<ConfirmAction
				title={
					onAddWithoutLinking ? `How should this ${providerLabel} bot be added?` : replacement.title
				}
				description={
					<>
						{replacement.limit}{" "}
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
								{replacement.linkingBefore}
								<span className="font-medium text-foreground [overflow-wrap:anywhere]">
									{targetName}
								</span>
								{replacement.linkingAfter}
							</>
						)}
					</>
				}
				confirmLabel={replacement.confirm}
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
