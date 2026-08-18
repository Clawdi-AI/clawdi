"use client";

import {
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
	pendingAction,
	onBack,
	onInstall,
	onRemove,
	onRetryCatalog,
}: {
	item: AgentPluginInventoryItem;
	runtime: HostedRuntime;
	catalogError: unknown | null;
	pendingAction: AgentPluginPendingAction;
	onBack: () => void;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetryCatalog: () => void;
}) {
	const title = pluginDisplayName(item);
	const status = item.desired ? agentPluginStatusPresentation(item.desired) : null;
	const installability = item.catalog ? agentPluginInstallability(item.catalog, runtime) : null;
	const hasUpdate = pluginHasUpdate(item);
	const canInstall = Boolean(
		item.catalog && installability?.installable && (!item.desired || hasUpdate),
	);
	const showCompatibilityWarning = Boolean(installability?.reason && (!item.desired || hasUpdate));

	return (
		<div data-hosted="true" data-v2="true" className="contents">
			<Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
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
			<PageHeader
				title={title}
				icon={
					<IconChip tint={identityFor(item.name).colorClasses}>
						<Blocks />
					</IconChip>
				}
				description={
					item.catalog?.description ?? "This installed version is no longer listed in the Store."
				}
				titleAdornment={
					status ? (
						<StatusBadge status={status.tone} withDot>
							{status.label}
						</StatusBadge>
					) : undefined
				}
				status={
					item.catalog?.publisher ? <DetailMeta>{item.catalog.publisher}</DetailMeta> : undefined
				}
				actions={
					<PluginDetailActions
						item={item}
						canInstall={canInstall}
						installability={installability}
						pendingAction={pendingAction}
						onInstall={onInstall}
						onRemove={onRemove}
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
				<Stat icon={Tag} label={`v${pluginVersion(item)}`} />
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
	installability,
	pendingAction,
	onInstall,
	onRemove,
}: {
	item: AgentPluginInventoryItem;
	canInstall: boolean;
	installability: ReturnType<typeof agentPluginInstallability> | null;
	pendingAction: AgentPluginPendingAction;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
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
					Component details are unavailable for this historical installation.
				</p>
			</DetailPanel>
		);
	}
	const servers = Object.entries(entry.components.mcpServers).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return (
		<DetailPanel className="space-y-4">
			<PanelHeading />
			<div className="divide-y">
				{entry.components.skills.map((skill) => (
					<ComponentRow key={`skill:${skill}`} icon={BookOpen} label="Skill" name={skill} />
				))}
				{servers.map(([name]) => (
					<ComponentRow key={`mcp:${name}`} icon={Server} label="MCP server" name={name} />
				))}
			</div>
		</DetailPanel>
	);
}

function PanelHeading() {
	return (
		<div className="flex items-center gap-2">
			<Box className="size-4 text-muted-foreground" />
			<h2 className="text-sm font-semibold">Package contents</h2>
		</div>
	);
}

function ComponentRow({
	icon: Icon,
	label,
	name,
}: {
	icon: typeof BookOpen;
	label: string;
	name: string;
}) {
	return (
		<div className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
			<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<div className="text-xs text-muted-foreground">{label}</div>
				<code className="mt-0.5 block break-all text-sm">{name}</code>
			</div>
		</div>
	);
}
