"use client";

import { Blocks, Plus, RefreshCw, Trash2 } from "lucide-react";
import { HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import type { HostedRuntime } from "@/hosted/runtimes";
import { identityFor } from "@/lib/identity";
import {
	type AgentPluginInventoryItem,
	agentPluginActionState,
	agentPluginComponentSummary,
	pluginDisplayName,
} from "./agent-plugin-model";

export type AgentPluginPendingAction = "install" | "remove" | "retry" | null;

export function AgentPluginCard({
	item,
	runtime,
	pendingAction,
	mutationsBlocked,
	onOpen,
	onInstall,
	onRemove,
	onRetry,
}: {
	item: AgentPluginInventoryItem;
	runtime: HostedRuntime;
	pendingAction: AgentPluginPendingAction;
	mutationsBlocked: boolean;
	onOpen: (name: string) => void;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetry: (item: AgentPluginInventoryItem) => Promise<unknown>;
}) {
	const title = pluginDisplayName(item);
	const { status, installability, hasUpdate, canInstall, canRetry, version } =
		agentPluginActionState(item, runtime);

	return (
		<div data-hosted="true" data-v2="true" className="contents">
			<HeroCard
				className="min-h-36"
				onClick={() => onOpen(item.name)}
				ariaLabel={`View ${title} details`}
				icon={
					<IconChip size="sm" tint={identityFor(item.name).colorClasses} className="rounded-lg">
						<Blocks />
					</IconChip>
				}
				title={title}
				badges={
					status || hasUpdate ? (
						<>
							{status ? (
								<StatusBadge status={status.tone} withDot>
									{status.label}
								</StatusBadge>
							) : null}
							{hasUpdate ? <StatusBadge status="info">Update available</StatusBadge> : null}
						</>
					) : undefined
				}
				description={
					item.catalog?.description ?? "This plugin is no longer available in the Store."
				}
				footer={[
					item.catalog?.publisher,
					version,
					item.catalog ? agentPluginComponentSummary(item.catalog) : null,
				]}
				actionsVisibility="always"
				actions={
					<>
						{item.desired ? (
							<ConfirmAction
								title={`Remove ${title}?`}
								description={<p>This removes its Skills and MCP servers from the agent.</p>}
								confirmLabel="Remove plugin"
								destructive
								onConfirm={() => onRemove(item)}
							>
								<Button
									variant="ghost"
									size="sm"
									disabled={mutationsBlocked}
									className="text-muted-foreground hover:text-destructive"
								>
									{pendingAction === "remove" ? <Spinner /> : <Trash2 />}
									{pendingAction === "remove" ? "Removing…" : "Remove"}
								</Button>
							</ConfirmAction>
						) : null}
						{canInstall ? (
							<Button
								size="sm"
								variant={hasUpdate ? "outline" : "default"}
								disabled={mutationsBlocked}
								onClick={() => void onInstall(item).catch(() => undefined)}
							>
								{pendingAction === "install" ? <Spinner /> : hasUpdate ? <RefreshCw /> : <Plus />}
								{pendingAction === "install"
									? hasUpdate
										? "Updating…"
										: "Installing…"
									: hasUpdate
										? "Update"
										: "Install"}
							</Button>
						) : !item.desired && installability ? (
							<Button
								size="sm"
								variant="outline"
								disabled
								title={installability.reason ?? undefined}
							>
								{installability.label}
							</Button>
						) : null}
						{canRetry ? (
							<Button
								size="sm"
								disabled={mutationsBlocked}
								onClick={() => void onRetry(item).catch(() => undefined)}
							>
								{pendingAction === "retry" ? <Spinner /> : <RefreshCw />}
								{pendingAction === "retry" ? "Retrying…" : "Retry"}
							</Button>
						) : null}
					</>
				}
			/>
		</div>
	);
}
