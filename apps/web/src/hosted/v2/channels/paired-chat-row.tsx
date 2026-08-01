"use client";

import { Link2Off, MessageCircle, MessagesSquare } from "lucide-react";
import { EntityHeader } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
	"ml-4 grid min-h-12 grid-cols-[minmax(0,1fr)] items-center gap-2 border-l-2 border-muted py-2 pr-0 pl-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3";

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
	const discordUnpairInstruction = `Run /bot_unpair in this ${scope}.`;

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
					...(provider !== "discord" && unpair.error
						? [
								<span key="error" className="font-medium text-destructive">
									Couldn&apos;t unpair · Try again
								</span>,
							]
						: []),
				]}
			/>
			<div className="flex min-h-8 min-w-0 justify-end sm:w-28 sm:shrink-0">
				{provider === "discord" ? (
					<p className="w-full text-right text-xs text-muted-foreground">
						{discordUnpairInstruction}
					</p>
				) : (
					<Tooltip>
						<TooltipTrigger render={<span className="inline-flex size-8" />}>
							<ConfirmAction
								title={`Unpair ${chatName}?`}
								description="Only this chat will be disconnected. Other chats and the connected channel stay active."
								confirmLabel="Unpair chat"
								destructive
								onConfirm={() => unpair.mutateAsync(binding.id)}
							>
								<Button
									variant="ghost"
									size="icon-sm"
									className={CHANNEL_DESTRUCTIVE_ACTION_CLASS}
									disabled={unpair.isPending}
									aria-label={`Unpair ${chatName}`}
								>
									{unpair.isPending ? (
										<Spinner className="size-3.5" />
									) : (
										<Link2Off className="size-3.5" />
									)}
								</Button>
							</ConfirmAction>
						</TooltipTrigger>
						<TooltipContent>Unpair {chatName}</TooltipContent>
					</Tooltip>
				)}
			</div>
		</div>
	);
}
