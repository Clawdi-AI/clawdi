"use client";

import {
	AlertCircle,
	ArrowLeft,
	Blocks,
	BookOpen,
	Box,
	Clock3,
	RefreshCw,
	Server,
	Tag,
} from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { DetailMeta, DetailStats } from "@/components/detail/layout";
import { IconChip } from "@/components/icon-chip";
import { Stat } from "@/components/meta/stat";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { HostedRuntime } from "@/hosted/runtimes";
import { identityFor } from "@/lib/identity";
import { AgentPluginActions, type AgentPluginPendingAction } from "./agent-plugin-actions";
import {
	type AgentPluginCatalogEntry,
	type AgentPluginInventoryItem,
	agentPluginActionState,
	pluginDisplayName,
} from "./agent-plugin-model";

export function AgentPluginDetail({
	item,
	runtime,
	catalogError,
	desiredStateError,
	desiredStateRetrying,
	pendingAction,
	mutationsBlocked,
	onBack,
	onInstall,
	onRemove,
	onRetry,
	onRetryCatalog,
	onRetryDesired,
}: {
	item: AgentPluginInventoryItem;
	runtime: HostedRuntime;
	catalogError: unknown | null;
	desiredStateError: boolean;
	desiredStateRetrying: boolean;
	pendingAction: AgentPluginPendingAction;
	mutationsBlocked: boolean;
	onBack: () => void;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetry: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetryCatalog: () => void;
	onRetryDesired: () => void;
}) {
	const title = pluginDisplayName(item);
	const actionState = agentPluginActionState(item, runtime);
	const { status, installability, hasUpdate, version } = actionState;
	const showCompatibilityWarning = Boolean(installability?.reason && (!item.desired || hasUpdate));
	const installFailed = item.desired?.convergence === "failed";
	const waitingForAgent = actionState.primaryAction?.kind === "waiting";

	return (
		<div data-hosted="true" data-v2="true" className="space-y-6">
			<Button variant="ghost" size="sm" className="w-fit sm:hidden" onClick={onBack}>
				<ArrowLeft />
				Back to Plugins
			</Button>
			{catalogError ? (
				<ApiErrorPanel
					error={catalogError}
					onRetry={onRetryCatalog}
					title="Store details unavailable"
				/>
			) : null}
			{desiredStateError ? (
				<Alert>
					<AlertCircle />
					<AlertTitle>Couldn't load installed plugins</AlertTitle>
					<AlertDescription>Showing Store details without installed status.</AlertDescription>
					<AlertAction>
						<Button
							size="sm"
							variant="outline"
							disabled={desiredStateRetrying}
							onClick={onRetryDesired}
						>
							{desiredStateRetrying ? <Spinner /> : <RefreshCw />}
							Retry
						</Button>
					</AlertAction>
				</Alert>
			) : null}
			<PageHeader
				title={title}
				icon={
					<IconChip tint={identityFor(item.name).colorClasses}>
						<Blocks />
					</IconChip>
				}
				description={
					item.catalog?.description ?? "This plugin is no longer available in the Store."
				}
				status={
					item.catalog?.publisher ? <DetailMeta>{item.catalog.publisher}</DetailMeta> : undefined
				}
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
			{installFailed && status ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Plugin installation failed</AlertTitle>
					<AlertDescription>{status.description}</AlertDescription>
				</Alert>
			) : waitingForAgent && status ? (
				<Alert>
					<Clock3 />
					<AlertTitle>Agent hasn't picked up this change</AlertTitle>
					<AlertDescription>{status.description}</AlertDescription>
				</Alert>
			) : showCompatibilityWarning && installability ? (
				<Alert>
					<Blocks />
					<AlertTitle>{installability.label}</AlertTitle>
					<AlertDescription>{installability.reason}</AlertDescription>
				</Alert>
			) : null}
			<DetailStats>
				<Stat icon={Tag} label={version} />
				{item.catalog ? (
					<>
						<Stat
							icon={BookOpen}
							label={`${item.catalog.components.skills.length} Skill${item.catalog.components.skills.length === 1 ? "" : "s"}`}
						/>
						<Stat
							icon={Server}
							label={`${Object.keys(item.catalog.components.mcpServers).length} MCP server${Object.keys(item.catalog.components.mcpServers).length === 1 ? "" : "s"}`}
						/>
					</>
				) : null}
			</DetailStats>
			<PluginDetailsPanel entry={item.catalog} />
		</div>
	);
}

function PluginDetailsPanel({ entry }: { entry: AgentPluginCatalogEntry | null }) {
	if (!entry) {
		return (
			<section className="space-y-3">
				<PanelHeading />
				<p className="text-sm text-muted-foreground">
					Details are no longer available for this plugin.
				</p>
			</section>
		);
	}
	const skills = entry.components.skills;
	const servers = Object.keys(entry.components.mcpServers).sort((left, right) =>
		left.localeCompare(right),
	);
	return (
		<section className="space-y-4">
			<PanelHeading />
			{skills.length === 0 && servers.length === 0 ? (
				<p className="text-sm text-muted-foreground">This plugin has no listed components.</p>
			) : (
				<>
					<ComponentGroup icon={BookOpen} label="Skills" names={skills} />
					<ComponentGroup icon={Server} label="MCP servers" names={servers} />
				</>
			)}
		</section>
	);
}

function PanelHeading() {
	return (
		<div className="flex items-center gap-2">
			<Box className="size-4 text-muted-foreground" />
			<h2 className="text-sm font-semibold">Includes</h2>
		</div>
	);
}

function ComponentGroup({
	icon: Icon,
	label,
	names,
}: {
	icon: typeof BookOpen;
	label: string;
	names: readonly string[];
}) {
	if (names.length === 0) return null;
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Icon className="size-3.5" />
				{label}
			</div>
			<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
				{names.map((name) => (
					<div
						key={name}
						className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2"
					>
						<Icon className="size-4 shrink-0 text-muted-foreground" />
						<code title={name} className="min-w-0 truncate text-sm">
							{name}
						</code>
					</div>
				))}
			</div>
		</div>
	);
}
