"use client";

import {
	AlertCircle,
	ArrowLeft,
	Blocks,
	BookOpen,
	Box,
	Plus,
	RefreshCw,
	Server,
	Tag,
	Trash2,
} from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { DetailMeta, DetailPanel, DetailStats } from "@/components/detail/layout";
import { IconChip } from "@/components/icon-chip";
import { Stat } from "@/components/meta/stat";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import type { HostedRuntime } from "@/hosted/runtimes";
import { identityFor } from "@/lib/identity";
import type { AgentPluginPendingAction } from "./agent-plugin-card";
import {
	type AgentPluginCatalogEntry,
	type AgentPluginInventoryItem,
	agentPluginInstallability,
	agentPluginStatusPresentation,
	pluginDisplayName,
	pluginHasUpdate,
	pluginVersion,
} from "./agent-plugin-model";

export function AgentPluginDetail({
	item,
	runtime,
	catalogError,
	desiredStateError,
	desiredStateRetrying,
	pendingAction,
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
	onBack: () => void;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetry: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetryCatalog: () => void;
	onRetryDesired: () => void;
}) {
	const title = pluginDisplayName(item);
	const status = item.desired ? agentPluginStatusPresentation(item.desired) : null;
	const installability = item.catalog ? agentPluginInstallability(item.catalog, runtime) : null;
	const hasUpdate = pluginHasUpdate(item);
	const installFailed = item.desired?.convergence === "failed";
	const canRetry = Boolean(installFailed && item.catalog && installability?.installable);
	const canInstall = Boolean(
		item.catalog && installability?.installable && !installFailed && (!item.desired || hasUpdate),
	);
	const showCompatibilityWarning = Boolean(installability?.reason && (!item.desired || hasUpdate));
	const version =
		hasUpdate && item.desired && item.catalog
			? `v${item.desired.version} → v${item.catalog.version}`
			: `v${pluginVersion(item)}`;

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
				titleAdornment={
					(status && item.desired?.convergence === "installed") || hasUpdate ? (
						<>
							{status && item.desired?.convergence === "installed" ? (
								<StatusBadge status={status.tone} withDot>
									{status.label}
								</StatusBadge>
							) : null}
							{hasUpdate ? <StatusBadge status="info">Update available</StatusBadge> : null}
						</>
					) : undefined
				}
				status={
					item.catalog?.publisher ? <DetailMeta>{item.catalog.publisher}</DetailMeta> : undefined
				}
				actions={
					<PluginDetailActions
						item={item}
						canInstall={canInstall}
						canRetry={canRetry}
						installability={installability}
						pendingAction={pendingAction}
						onInstall={onInstall}
						onRemove={onRemove}
						onRetry={onRetry}
					/>
				}
			/>
			{status && item.desired?.convergence !== "installed" ? (
				<Alert variant={status.tone === "destructive" ? "destructive" : "default"}>
					<RefreshCw />
					<AlertTitle>{status.label}</AlertTitle>
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

function PluginDetailActions({
	item,
	canInstall,
	canRetry,
	installability,
	pendingAction,
	onInstall,
	onRemove,
	onRetry,
}: {
	item: AgentPluginInventoryItem;
	canInstall: boolean;
	canRetry: boolean;
	installability: ReturnType<typeof agentPluginInstallability> | null;
	pendingAction: AgentPluginPendingAction;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetry: (item: AgentPluginInventoryItem) => Promise<unknown>;
}) {
	const updating = pluginHasUpdate(item);
	return (
		<>
			{canInstall ? (
				<Button
					size="sm"
					variant={updating ? "outline" : "default"}
					disabled={pendingAction !== null}
					onClick={() => void onInstall(item).catch(() => undefined)}
				>
					{pendingAction === "install" ? <Spinner /> : updating ? <RefreshCw /> : <Plus />}
					{pendingAction === "install"
						? updating
							? "Updating…"
							: "Installing…"
						: updating
							? `Update to v${item.catalog?.version}`
							: "Install"}
				</Button>
			) : !item.desired && installability ? (
				<Button size="sm" variant="outline" disabled title={installability.reason ?? undefined}>
					{installability.label}
				</Button>
			) : null}
			{canRetry ? (
				<Button
					size="sm"
					disabled={pendingAction !== null}
					onClick={() => void onRetry(item).catch(() => undefined)}
				>
					{pendingAction === "retry" ? <Spinner /> : <RefreshCw />}
					{pendingAction === "retry" ? "Retrying…" : "Retry"}
				</Button>
			) : null}
			{item.desired ? (
				<ConfirmAction
					title={`Remove ${pluginDisplayName(item)}?`}
					description={<p>The agent will remove the Skills and MCP servers from this plugin.</p>}
					confirmLabel="Remove plugin"
					destructive
					onConfirm={() => onRemove(item)}
				>
					<Button
						variant="outline"
						size="sm"
						disabled={pendingAction !== null}
						className="text-destructive hover:text-destructive"
					>
						{pendingAction === "remove" ? <Spinner /> : <Trash2 />}
						{pendingAction === "remove" ? "Removing…" : "Remove"}
					</Button>
				</ConfirmAction>
			) : null}
		</>
	);
}

function PluginDetailsPanel({ entry }: { entry: AgentPluginCatalogEntry | null }) {
	if (!entry) {
		return (
			<DetailPanel className="space-y-3">
				<PanelHeading />
				<p className="text-sm text-muted-foreground">
					Details are no longer available for this plugin.
				</p>
			</DetailPanel>
		);
	}
	const skills = entry.components.skills;
	const servers = Object.keys(entry.components.mcpServers).sort((left, right) =>
		left.localeCompare(right),
	);
	return (
		<DetailPanel className="space-y-4">
			<PanelHeading />
			{skills.length === 0 && servers.length === 0 ? (
				<p className="text-sm text-muted-foreground">This plugin has no listed components.</p>
			) : (
				<>
					<ComponentGroup icon={BookOpen} label="Skills" names={skills} />
					<ComponentGroup icon={Server} label="MCP servers" names={servers} />
				</>
			)}
		</DetailPanel>
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
			<div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
				{names.map((name) => (
					<code key={name} className="min-w-0 break-all text-sm">
						{name}
					</code>
				))}
			</div>
		</div>
	);
}
