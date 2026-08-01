"use client";

import { Link2, Plus } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EntityHeader } from "@/components/entity-card";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ProviderChip } from "@/hosted/v2/channels/channel-ui";

export type AddChannelOption = {
	id: string;
	name: string;
	provider: string;
};

export function AddChannelDialog({
	open,
	onOpenChange,
	clawdiBots,
	customBots,
	isLoading,
	clawdiError,
	customError,
	onRetryClawdi,
	onRetryCustom,
	addingAccountId,
	onAdd,
	onConnectCustomBot,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	clawdiBots: AddChannelOption[];
	customBots: AddChannelOption[];
	isLoading: boolean;
	clawdiError: Error | null;
	customError: Error | null;
	onRetryClawdi: () => void;
	onRetryCustom: () => void;
	addingAccountId: string | null;
	onAdd: (accountId: string) => Promise<boolean>;
	onConnectCustomBot: () => void;
}) {
	const hasBots = clawdiBots.length > 0 || customBots.length > 0;

	async function add(accountId: string) {
		if (await onAdd(accountId)) onOpenChange(false);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				data-hosted="true"
				data-v2="true"
				data-agent-add-channel-dialog
				className="max-h-[calc(100dvh-2rem)] min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-lg"
			>
				<DialogHeader className="border-b p-5 pr-14">
					<DialogTitle>Add channel</DialogTitle>
					<DialogDescription>Choose a bot for this Agent.</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5">
					{clawdiError ? (
						<ApiErrorPanel
							error={clawdiError}
							title="Couldn't load Clawdi bots"
							onRetry={onRetryClawdi}
						/>
					) : null}
					{customError ? (
						<ApiErrorPanel
							error={customError}
							title="Couldn't load Custom bots"
							onRetry={onRetryCustom}
						/>
					) : null}
					{isLoading && !hasBots ? <AddChannelSkeleton /> : null}
					<AddChannelSection
						title="Clawdi bots"
						bots={clawdiBots}
						addingAccountId={addingAccountId}
						onAdd={add}
					/>
					<AddChannelSection
						title="Custom bots"
						bots={customBots}
						addingAccountId={addingAccountId}
						onAdd={add}
					/>
					{!isLoading && !clawdiError && !customError && !hasBots ? (
						<div className="py-6 text-center">
							<p className="text-sm font-medium">No Clawdi or Custom bots to add</p>
							<p className="mt-1 text-sm text-muted-foreground">
								Connect a Custom bot, or unlink a channel to replace it.
							</p>
						</div>
					) : null}
				</div>

				<DialogFooter className="border-t p-4 sm:p-5">
					<Button
						variant={hasBots ? "outline" : "default"}
						className="min-w-0 whitespace-normal"
						onClick={onConnectCustomBot}
					>
						<Plus className="size-4" />
						Connect custom bot
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function AddChannelSection({
	title,
	bots,
	addingAccountId,
	onAdd,
}: {
	title: string;
	bots: AddChannelOption[];
	addingAccountId: string | null;
	onAdd: (accountId: string) => Promise<void>;
}) {
	if (bots.length === 0) return null;
	return (
		<section className="min-w-0 space-y-2" data-agent-add-channel-section={title}>
			<h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
			<div className="min-w-0 space-y-2">
				{bots.map((bot) => {
					const adding = addingAccountId === bot.id;
					return (
						<div
							key={bot.id}
							data-add-channel-id={bot.id}
							className="grid min-w-0 grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-2 rounded-lg border p-3"
						>
							<EntityHeader
								className="min-w-0"
								icon={<ProviderChip provider={bot.provider} size="sm" />}
								title={bot.name}
								titleAttribute={bot.name}
							/>
							<Button
								type="button"
								size="sm"
								className="w-full min-w-0"
								disabled={addingAccountId !== null}
								onClick={() => void onAdd(bot.id)}
							>
								{adding ? <Spinner className="size-3.5" /> : <Link2 className="size-3.5" />}
								<span>{adding ? "Adding…" : "Add"}</span>
							</Button>
						</div>
					);
				})}
			</div>
		</section>
	);
}

function AddChannelSkeleton() {
	return (
		<div role="status" className="space-y-2">
			<span className="sr-only">Loading Clawdi and Custom bots</span>
			{[0, 1].map((index) => (
				<div key={index} className="flex min-h-14 items-center gap-3 rounded-lg border p-3">
					<Skeleton className="size-8 shrink-0 rounded-md" />
					<Skeleton className="h-4 min-w-0 flex-1" />
					<Skeleton className="h-8 w-26 shrink-0 rounded-md" />
				</div>
			))}
		</div>
	);
}
