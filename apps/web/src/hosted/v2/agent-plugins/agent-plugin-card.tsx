"use client";

import { Blocks, Plus, RefreshCw, Trash2 } from "lucide-react";
import { HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import type { HostedRuntime } from "@/hosted/runtimes";
import { runtimeDisplayName } from "@/hosted/runtimes";
import type { AgentRouteQuery } from "@/lib/agent-routes";
import { agentPluginDetailLink } from "@/lib/agent-routes";
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

export function AgentPluginCard({
	item,
	agentId,
	runtime,
	routeSearch,
	pendingAction,
	mutationsBlocked,
	onInstall,
	onRemove,
}: {
	item: AgentPluginInventoryItem;
	agentId: string;
	runtime: HostedRuntime;
	routeSearch?: AgentRouteQuery;
	pendingAction: "install" | "remove" | null;
	mutationsBlocked: boolean;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
}) {
	const title = pluginDisplayName(item);
	const identity = identityFor(item.name);
	const status = item.desired ? agentPluginStatusPresentation(item.desired) : null;
	const installability = item.catalog ? agentPluginInstallability(item.catalog, runtime) : null;
	const hasUpdate = pluginHasUpdate(item);
	const installLabel = hasUpdate ? "Update" : "Install";
	const canInstall = Boolean(
		item.catalog && installability?.installable && (!item.desired || hasUpdate),
	);
	const runtimeLabels = item.catalog?.runtimes.map(runtimeDisplayName).join(", ");

	return (
		<div data-hosted="true" data-v2="true" className="contents">
			<HeroCard
				className="min-h-40 gap-3"
				icon={
					<IconChip size="sm" tint={identity.colorClasses} className="rounded-lg">
						<Blocks />
					</IconChip>
				}
				title={title}
				badges={
					<>
						<Badge variant="outline">v{pluginVersion(item)}</Badge>
						{status ? (
							<StatusBadge status={status.tone} withDot>
								{status.label}
							</StatusBadge>
						) : null}
					</>
				}
				description={
					item.catalog?.description ??
					"This installed version is no longer listed in the current Store catalog."
				}
				footer={[item.catalog?.publisher ?? null, runtimeLabels ?? null]}
				actions={
					item.desired ? (
						<ConfirmAction
							title={`Remove ${title}?`}
							description={
								<p>The agent will remove this plugin the next time it reconciles desired state.</p>
							}
							confirmLabel="Remove plugin"
							destructive
							onConfirm={() => onRemove(item)}
						>
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={mutationsBlocked}
								className="text-muted-foreground hover:text-destructive"
								aria-label={`Remove ${title}`}
							>
								{pendingAction === "remove" ? <Spinner /> : <Trash2 />}
							</Button>
						</ConfirmAction>
					) : undefined
				}
				link={agentPluginDetailLink(agentId, item.name, routeSearch)}
				ariaLabel={`Open ${title}`}
			>
				<div className="relative z-10 mt-auto flex min-w-0 items-center justify-between gap-3">
					<span className="min-w-0 text-xs text-muted-foreground">
						{agentPluginComponentSummary(item.catalog)}
					</span>
					{canInstall ? (
						<Button
							size="sm"
							variant={hasUpdate ? "outline" : "default"}
							disabled={mutationsBlocked}
							onClick={() => void onInstall(item).catch(() => undefined)}
						>
							{pendingAction === "install" ? <Spinner /> : hasUpdate ? <RefreshCw /> : <Plus />}
							{installLabel}
						</Button>
					) : !item.desired && installability ? (
						<Button size="sm" variant="outline" disabled title={installability.reason ?? undefined}>
							{installability.label}
						</Button>
					) : null}
				</div>
			</HeroCard>
		</div>
	);
}
