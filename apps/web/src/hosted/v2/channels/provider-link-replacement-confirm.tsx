"use client";

import type { ReactElement } from "react";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";

export function ProviderLinkReplacementConfirm({
	provider,
	targetName,
	onConfirm,
	children,
}: {
	provider: string;
	targetName: string;
	onConfirm: () => unknown;
	children: ReactElement;
}) {
	const providerLabel = providerMeta(provider).label;
	return (
		<div data-hosted="true" data-v2="true" className="contents">
			<ConfirmAction
				title={`Replace this Agent’s ${providerLabel} link?`}
				description={
					<>
						This Agent can use one {providerLabel} bot at a time.{" "}
						<span className="font-medium text-foreground [overflow-wrap:anywhere]">
							{targetName}
						</span>{" "}
						will replace the current bot, and its paired chats will be removed from this Agent.
					</>
				}
				confirmLabel={`Replace ${providerLabel} link`}
				onConfirm={onConfirm}
			>
				{children}
			</ConfirmAction>
		</div>
	);
}
