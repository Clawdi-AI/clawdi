"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useIsMobile } from "@/hooks/use-mobile";
import {
	type AgentPairedChatItem,
	selectPairedChatsForLink,
} from "@/hosted/v2/channels/agent-channel-bindings.logic";
import { useChannelBindings } from "@/hosted/v2/channels/channels-hooks";
import { PairedChatRow } from "@/hosted/v2/channels/paired-chat-row";
import { cn } from "@/lib/utils";

export function PairedChatsDialog({
	agentId,
	accountId,
	linkId,
	channelName,
	provider,
	bindingCount,
}: {
	agentId: string;
	accountId: string;
	linkId: string;
	channelName: string;
	provider: string;
	bindingCount: number;
}) {
	const [open, setOpen] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const isMobile = useIsMobile();
	const bindings = useChannelBindings(accountId, open);
	const pairedChats = selectPairedChatsForLink({
		accountId,
		agentLinkId: linkId,
		bindings: bindings.data ?? [],
		provider,
	});
	const bindingsLoading = open && bindings.data === undefined && bindings.isPending;
	const bindingsError = Boolean(open && bindings.error && bindings.data === undefined);
	const descriptionCount = bindings.data === undefined ? bindingCount : pairedChats.length;
	const retryBindings = async () => {
		setRetrying(true);
		try {
			await bindings.refetch();
		} finally {
			setRetrying(false);
		}
	};
	const panelId = `paired-chats-${linkId}`;
	const label = `${bindingCount} paired ${bindingCount === 1 ? "chat" : "chats"}`;
	const description = `${descriptionCount} ${descriptionCount === 1 ? "chat uses" : "chats use"} this channel. Removing one affects only that chat.`;
	const trigger = (
		<button
			type="button"
			data-agent-paired-chats-trigger={linkId}
			className={cn(
				buttonVariants({ variant: "link", size: "xs" }),
				"h-auto max-w-full justify-start p-0 text-sm",
			)}
			aria-controls={panelId}
		>
			<span data-agent-paired-chats-label className="whitespace-nowrap">
				{label}
			</span>
		</button>
	);
	const list = (
		<PairedChatsList
			agentId={agentId}
			linkId={linkId}
			provider={provider}
			pairedChats={pairedChats}
			bindingsLoading={bindingsLoading}
			bindingsError={bindingsError}
			bindingsRetrying={retrying}
			onBindingsRetry={retryBindings}
		/>
	);

	if (isMobile) {
		return (
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetTrigger render={trigger} />
				<SheetContent
					id={panelId}
					data-hosted="true"
					data-v2="true"
					data-agent-channel-chats-for={linkId}
					side="bottom"
					className="top-2 min-w-0 gap-0 overflow-hidden rounded-t-xl pb-[env(safe-area-inset-bottom)] [&>*]:min-w-0"
				>
					<SheetHeader className="shrink-0 border-b p-4 pr-12">
						<SheetTitle>Paired chats</SheetTitle>
						<p
							data-agent-paired-chats-channel-name
							className="min-w-0 truncate text-sm font-medium"
							title={channelName}
						>
							{channelName}
						</p>
						<SheetDescription className="min-w-0 break-words [overflow-wrap:anywhere]">
							{description}
						</SheetDescription>
					</SheetHeader>
					<div
						data-agent-paired-chats-scroll
						className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-2"
					>
						{list}
					</div>
				</SheetContent>
			</Sheet>
		);
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={trigger} />
			<DialogContent
				id={panelId}
				data-hosted="true"
				data-v2="true"
				data-agent-channel-chats-for={linkId}
				className="max-h-[calc(100dvh-2rem)] min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-xl"
			>
				<DialogHeader className="border-b p-5 pr-14">
					<DialogTitle>Paired chats</DialogTitle>
					<p
						data-agent-paired-chats-channel-name
						className="min-w-0 truncate text-sm font-medium"
						title={channelName}
					>
						{channelName}
					</p>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<div
					data-agent-paired-chats-scroll
					className="min-h-0 max-h-[min(28rem,calc(100dvh-10rem))] overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-2"
				>
					{list}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function PairedChatsList({
	agentId,
	linkId,
	provider,
	pairedChats,
	bindingsLoading,
	bindingsError,
	bindingsRetrying,
	onBindingsRetry,
}: {
	agentId: string;
	linkId: string;
	provider: string;
	pairedChats: AgentPairedChatItem[];
	bindingsLoading: boolean;
	bindingsError: boolean;
	bindingsRetrying: boolean;
	onBindingsRetry: () => Promise<void>;
}) {
	return (
		<div data-agent-paired-chats-list={linkId} className="min-w-0 divide-y">
			{bindingsError ? (
				<div
					role="alert"
					className="grid min-h-14 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 px-1 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
				>
					<AlertCircle className="size-4 shrink-0 text-destructive" />
					<p className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
						{provider === "discord"
							? "Couldn’t load paired servers or direct messages"
							: "Couldn’t load paired chats"}
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="col-start-2 justify-self-start sm:col-start-3"
						disabled={bindingsRetrying}
						onClick={() => void onBindingsRetry()}
					>
						{bindingsRetrying ? (
							<Spinner className="size-3.5" />
						) : (
							<RefreshCw className="size-3.5" />
						)}
						{bindingsRetrying ? "Retrying…" : "Retry"}
					</Button>
				</div>
			) : null}
			{pairedChats.map((item) => (
				<PairedChatRow
					key={item.binding.id}
					agentId={agentId}
					accountId={item.accountId}
					binding={item.binding}
					provider={item.provider}
				/>
			))}
			{bindingsLoading && pairedChats.length === 0 ? (
				<div role="status" className="divide-y">
					<span className="sr-only">Loading paired chats</span>
					{[0, 1, 2].map((index) => (
						<div key={index} className="flex min-h-14 items-center gap-3 px-1 py-2.5">
							<Skeleton className="size-8 shrink-0 rounded-md" />
							<div className="min-w-0 flex-1 space-y-1.5">
								<Skeleton className="h-4 w-40 max-w-full" />
								<Skeleton className="h-3 w-24 max-w-2/3" />
							</div>
							<Skeleton className="h-8 w-28 shrink-0 rounded-md" />
						</div>
					))}
				</div>
			) : null}
			{!bindingsLoading && !bindingsError && pairedChats.length === 0 ? (
				<p className="px-1 py-6 text-center text-sm text-muted-foreground">No paired chats yet.</p>
			) : null}
		</div>
	);
}
