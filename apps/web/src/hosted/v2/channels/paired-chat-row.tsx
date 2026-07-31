"use client";

import { Link2Off, MessageCircle, MessagesSquare } from "lucide-react";
import { EntityHeader } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";
import { ChannelStatusBadge, isNormalChannelStatus } from "@/hosted/v2/channels/channel-ui";
import { useDeleteChannelBinding } from "@/hosted/v2/channels/channels-hooks";
import { pairedChatTitle } from "@/hosted/v2/channels/paired-chat-row.logic";
import { cn } from "@/lib/utils";

export const PAIRED_CHAT_ROW_CLASS =
	"ml-4 grid min-h-12 grid-cols-[minmax(0,1fr)] items-center gap-2 border-l-2 border-muted py-2 pr-0 pl-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3";

export function PairedChatRow({
	accountId,
	binding,
	provider,
	channelName,
	agentName,
	className,
}: {
	accountId: string;
	binding: ChannelBinding;
	provider: string;
	channelName?: string;
	agentName?: string;
	className?: string;
}) {
	const unpair = useDeleteChannelBinding(accountId);
	const chatType = binding.external_chat_type?.toLowerCase();
	const privateChat = chatType === "private";
	const chatName = pairedChatTitle(binding);
	const relationship = agentName
		? `Paired to ${agentName}`
		: channelName
			? `Through ${channelName}`
			: null;

	return (
		<div
			data-hosted="true"
			data-v2="true"
			data-channel-binding-id={binding.id}
			data-channel-binding-account-id={accountId}
			data-channel-binding-agent-link-id={binding.agent_link_id ?? undefined}
			data-channel-binding-provider={provider}
			className={cn(PAIRED_CHAT_ROW_CLASS, className)}
		>
			<EntityHeader
				className="min-w-0"
				icon={<IconChip size="sm">{privateChat ? <MessageCircle /> : <MessagesSquare />}</IconChip>}
				title={chatName}
				meta={[
					...(relationship ? [<span key="relationship">{relationship}</span>] : []),
					...(isNormalChannelStatus(binding.status)
						? []
						: [<ChannelStatusBadge key="status" status={binding.status} />]),
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
