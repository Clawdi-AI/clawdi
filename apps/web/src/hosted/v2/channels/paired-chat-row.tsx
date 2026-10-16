"use client";

import {
	pairedChatKindLabel,
	pairedChatScopeLabel,
	pairedChatsCopy,
	pairedChatTitle,
	relativeTime,
	unpairChatTitle,
} from "@clawdi/shared/view";
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
import { cn } from "@/lib/utils";

export const PAIRED_CHAT_ROW_CLASS =
	"grid min-h-14 min-w-0 grid-cols-[minmax(0,1fr)_7rem] items-center gap-1.5 px-1 py-2.5";

export function PairedChatRow({
	agentId,
	accountId,
	binding,
	provider,
	className,
}: {
	agentId: string;
	accountId: string;
	binding: ChannelBinding;
	provider: string;
	className?: string;
}) {
	const unpair = useDeleteChannelBinding(accountId, agentId);
	const chatType = binding.external_chat_type?.toLowerCase();
	const scope = pairedChatScopeLabel(provider, binding);
	const privateChat = chatType === "private" || scope === "direct message";
	const chatName = pairedChatTitle(binding, provider);
	const displayName = binding.external_chat_name?.trim() || binding.external_chat_id;
	const scopeLabel = pairedChatKindLabel(provider, binding);
	const metaDetail = unpair.error ? (
		<span className="font-medium text-destructive">{pairedChatsCopy.unpairFailedInline}</span>
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
					title={unpairChatTitle(chatName)}
					description={pairedChatsCopy.unpairDescription}
					confirmLabel={pairedChatsCopy.unpairConfirm}
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
								{pairedChatsCopy.unpairing}
							</>
						) : (
							<>
								<Link2Off className="size-3.5" />
								<span>{pairedChatsCopy.unpair}</span>
							</>
						)}
					</Button>
				</ConfirmAction>
			</div>
		</div>
	);
}
