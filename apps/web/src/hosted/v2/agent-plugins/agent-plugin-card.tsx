"use client";

import { agentPluginCardClasses } from "@clawdi/shared/ui";
import { agentSurfaceCopy, identityFor } from "@clawdi/shared/view";
import { Blocks } from "lucide-react";
import { HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import type { HostedRuntime } from "@/hosted/runtimes";
import { AgentPluginActions, type AgentPluginPendingAction } from "./agent-plugin-actions";
import {
	type AgentPluginInventoryItem,
	agentPluginActionState,
	agentPluginComponentSummary,
	pluginDisplayName,
} from "./agent-plugin-model";

export type { AgentPluginPendingAction } from "./agent-plugin-actions";

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
	const actionState = agentPluginActionState(item, runtime);

	return (
		<div data-hosted="true" data-v2="true" className={agentPluginCardClasses.root}>
			<HeroCard
				className={agentPluginCardClasses.card}
				onClick={() => onOpen(item.name)}
				ariaLabel={`View ${title} details`}
				icon={
					<IconChip
						size="sm"
						tint={identityFor(item.name).colorClasses}
						className={agentPluginCardClasses.iconTile}
					>
						<Blocks />
					</IconChip>
				}
				title={title}
				description={
					item.catalog?.description ?? agentSurfaceCopy.thisPluginIsNoLongerAvailableInTheStore
				}
				footer={[
					item.catalog?.publisher,
					actionState.version,
					item.catalog ? agentPluginComponentSummary(item.catalog) : null,
				]}
				footerWrap
				actionsVisibility="always"
				actions={
					<AgentPluginActions
						item={item}
						state={actionState}
						pendingAction={pendingAction}
						mutationsBlocked={mutationsBlocked}
						onInstall={onInstall}
						onRemove={onRemove}
						onRetry={onRetry}
					/>
				}
			/>
		</div>
	);
}
