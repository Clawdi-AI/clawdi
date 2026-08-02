"use client";

import { Link2Off, MessageCircle, MessagesSquare } from "lucide-react";
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
	"grid min-h-14 min-w-0 grid-cols-[minmax(0,1fr)_7rem] items-center gap-1.5 px-1 py-2.5";

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
	const displayName = binding.external_chat_name?.trim() || binding.external_chat_id;
	const scopeLabel =
		provider === "discord"
			? scope === "direct message"
				? "Direct message"
				: "Server"
			: chatType === "private"
				? "Private chat"
				: chatType === "group" || chatType === "supergroup"
					? "Group chat"
					: "Chat";
	const metaDetail = unpair.error ? (
		<span className="font-medium text-destructive">Couldn&apos;t unpair · Try again</span>
	) : !isNormalChannelStatus(binding.status) ? (
		<ChannelStatusBadge status={binding.status} />
	) : binding.last_message_at ? (
		<span>Last activity {relativeTime(binding.last_message_at)}</span>
	) : null;

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
				title={displayName}
				titleClassName="truncate"
				titleAttribute={displayName}
				meta={
					<span className="flex min-w-0 items-center">
						<span className="shrink-0">{scopeLabel}</span>
						{metaDetail ? (
							<>
								<span className="mx-1.5 shrink-0 text-muted-foreground/40">·</span>
								<span className="min-w-0 truncate">{metaDetail}</span>
							</>
						) : null}
					</span>
				}
			/>
			<div className="flex min-h-8 min-w-0 justify-end">
				<ConfirmAction
					title={`Unpair ${chatName}?`}
					description="Only this chat will be disconnected. Other chats and the connected channel stay active."
					confirmLabel="Unpair chat"
					destructive
					onConfirm={() =>
						unpair.mutateAsync({
							params: { path: { account_id: accountId, binding_id: binding.id } },
						})
					}
				>
					<Button
						variant="ghost"
						size="sm"
						className={cn(CHANNEL_DESTRUCTIVE_ACTION_CLASS, "w-full min-w-0")}
						disabled={unpair.isPending}
						aria-label={`${unpair.isPending ? "Unpairing" : "Unpair"} ${chatName}`}
					>
						{unpair.isPending ? (
							<>
								<Spinner className="size-3.5" />
								Unpairing…
							</>
						) : (
							<>
								<Link2Off className="size-3.5" />
								<span>Unpair</span>
							</>
						)}
					</Button>
				</ConfirmAction>
			</div>
		</div>
	);
}
