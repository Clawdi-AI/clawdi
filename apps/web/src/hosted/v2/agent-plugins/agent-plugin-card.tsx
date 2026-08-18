"use client";

import { Blocks, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
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
	agentPluginComponentSummary,
	agentPluginInstallability,
	agentPluginStatusPresentation,
	pluginDisplayName,
	pluginHasUpdate,
	pluginVersion,
} from "./agent-plugin-model";

export type AgentPluginPendingAction = "install" | "remove" | null;

export function AgentPluginCard({
	item,
	runtime,
	pendingAction,
	mutationsBlocked,
	onOpen,
	onInstall,
	onRemove,
}: {
	item: AgentPluginInventoryItem;
	runtime: HostedRuntime;
	pendingAction: AgentPluginPendingAction;
	mutationsBlocked: boolean;
	onOpen: (name: string) => void;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
}) {
	const title = pluginDisplayName(item);
	const status = item.desired ? agentPluginStatusPresentation(item.desired) : null;
	const installability = item.catalog ? agentPluginInstallability(item.catalog, runtime) : null;
	const hasUpdate = pluginHasUpdate(item);
	const canInstall = Boolean(
		item.catalog && installability?.installable && (!item.desired || hasUpdate),
	);

	return (
		<div data-hosted="true" data-v2="true" className="contents">
			<HeroCard
				className="min-h-36"
				icon={
					<IconChip size="sm" tint={identityFor(item.name).colorClasses} className="rounded-lg">
						<Blocks />
					</IconChip>
				}
				title={title}
				badges={
					status ? (
						<StatusBadge status={status.tone} withDot>
							{status.label}
						</StatusBadge>
					) : undefined
				}
				description={
					item.catalog?.description ?? "This installed version is no longer listed in the Store."
				}
				footer={[item.catalog?.publisher, `v${pluginVersion(item)}`]}
				footerClassName="mt-0"
			>
				<div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<span className="min-w-0 text-xs text-muted-foreground">
						{agentPluginComponentSummary(item.catalog)}
					</span>
					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onOpen(item.name)}
							aria-label={`View ${title} details`}
						>
							Details
							<ChevronRight />
						</Button>
						{item.desired ? (
							<ConfirmAction
								title={`Remove ${title}?`}
								description={<p>This removes its Skills and MCP servers from the agent.</p>}
								confirmLabel="Remove plugin"
								destructive
								onConfirm={() => onRemove(item)}
							>
								<Button
									variant="outline"
									size="sm"
									disabled={mutationsBlocked}
									className="text-destructive hover:text-destructive"
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
					</div>
				</div>
			</HeroCard>
		</div>
	);
}
