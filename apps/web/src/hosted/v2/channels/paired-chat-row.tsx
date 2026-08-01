"use client";

import { MessageCircle, MessagesSquare } from "lucide-react";
import { EntityHeader } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";
import {
	CHANNEL_DESTRUCTIVE_ACTION_CLASS,
	ChannelStatusBadge,
	isNormalChannelStatus,
} from "@/hosted/v2/channels/channel-ui";
import { useDeleteChannelBinding } from "@/hosted/v2/channels/channels-hooks";
import { pairedChatScopeLabel, pairedChatTitle } from "@/hosted/v2/channels/paired-chat-row.logic";
import { cn, relativeTime } from "@/lib/utils";

export const PAIRED_CHAT_ROW_CLASS =
	"grid min-h-14 grid-cols-[minmax(0,1fr)] items-center gap-2 px-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3";

export function PairedChatRow({
	accountId,
	binding,
	provider,
	className,
}: {
	accountId: string;
	binding: ChannelBinding;
	provider: string;
	className?: string;
}) {
	const unpair = useDeleteChannelBinding(accountId);
	const chatType = binding.external_chat_type?.toLowerCase();
	const scope = pairedChatScopeLabel(provider, binding);
	const privateChat = chatType === "private" || scope === "direct message";
	const chatName = pairedChatTitle(binding, provider);

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
				titleClassName="line-clamp-2 whitespace-normal break-words text-clip"
				meta={[
					...(binding.last_message_at
						? [<span key="activity">Last activity {relativeTime(binding.last_message_at)}</span>]
						: []),
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
			<div className="flex min-h-8 min-w-0 justify-end sm:shrink-0">
				<ConfirmAction
					title={`Unpair ${chatName}?`}
					description="Only this chat will be disconnected. Other chats and the connected channel stay active."
					confirmLabel="Unpair chat"
					destructive
					onConfirm={() => unpair.mutateAsync(binding.id)}
				>
					<Button
						variant="ghost"
						size="sm"
						className={CHANNEL_DESTRUCTIVE_ACTION_CLASS}
						disabled={unpair.isPending}
						aria-label={`${unpair.isPending ? "Unpairing" : "Unpair"} ${chatName}`}
					>
						{unpair.isPending ? (
							<>
								<Spinner className="size-3.5" />
								Unpairing…
							</>
						) : (
							"Unpair"
						)}
					</Button>
				</ConfirmAction>
			</div>
		</div>
	);
}
