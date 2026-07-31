"use client";

import { Link2Off } from "lucide-react";
import { EntityHeader } from "@/components/entity-card";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";
import { ChannelStatusBadge, CopyInline, ProviderChip } from "@/hosted/v2/channels/channel-ui";
import { useDeleteChannelBinding } from "@/hosted/v2/channels/channels-hooks";
import { cn } from "@/lib/utils";

export const PAIRED_CHAT_ROW_CLASS =
	"grid min-h-16 grid-cols-[minmax(0,1fr)] items-center gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3";

export function PairedChatRow({
	accountId,
	binding,
	provider,
	channelName,
	agentName,
	showChatId = false,
	className,
}: {
	accountId: string;
	binding: ChannelBinding;
	provider: string;
	channelName?: string;
	agentName?: string;
	showChatId?: boolean;
	className?: string;
}) {
	const unpair = useDeleteChannelBinding(accountId);
	const fallbackName = `${providerMeta(provider).label} chat`;
	const chatName = binding.external_chat_name ?? fallbackName;

	return (
		<div
			data-hosted="true"
			data-v2="true"
			data-channel-binding-id={binding.id}
			data-channel-binding-account-id={accountId}
			data-channel-binding-agent-link-id={binding.agent_link_id ?? undefined}
			className={cn(PAIRED_CHAT_ROW_CLASS, className)}
		>
			<EntityHeader
				className="min-w-0"
				icon={<ProviderChip provider={provider} size="sm" />}
				title={chatName}
				meta={[
					<span key="provider">{providerMeta(provider).label}</span>,
					...(channelName ? [<span key="channel">{channelName}</span>] : []),
					<span key="type" className="capitalize">
						{binding.external_chat_type ?? "chat"}
					</span>,
					<ChannelStatusBadge key="status" status={binding.status} />,
					...(agentName ? [<span key="agent">Agent: {agentName}</span>] : []),
					...(showChatId
						? [<CopyInline key="chat-id" value={binding.external_chat_id} label="chat ID" />]
						: []),
					...(unpair.error
						? [
								<span key="error" className="font-medium text-destructive">
									Couldn&apos;t unpair · Try again
								</span>,
							]
						: []),
				]}
			/>
			<div className="flex min-w-0 justify-end sm:shrink-0">
				<ConfirmAction
					title={`Unpair ${chatName}?`}
					description="Only this chat will be disconnected. Other chats and the connected channel stay active."
					confirmLabel="Unpair chat"
					destructive
					onConfirm={() => unpair.mutateAsync(binding.id)}
				>
					<Button variant="outline" size="sm" disabled={unpair.isPending}>
						{unpair.isPending ? (
							<Spinner className="size-3.5" />
						) : (
							<Link2Off className="size-3.5" />
						)}
						{unpair.isPending ? "Unpairing…" : unpair.error ? "Retry unpair" : "Unpair"}
					</Button>
				</ConfirmAction>
			</div>
		</div>
	);
}
