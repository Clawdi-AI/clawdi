"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
	Blocks,
	BookOpen,
	Box,
	Languages,
	Plus,
	RefreshCw,
	Server,
	Tag,
	Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailNotFound, DetailPanel, DetailStats } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS, HeroCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { Stat } from "@/components/meta/stat";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import type { HostedRuntime } from "@/hosted/runtimes";
import { runtimeDisplayName } from "@/hosted/runtimes";
import {
	type AgentRouteQuery,
	agentDeploymentRouteQuery,
	agentSectionHref,
} from "@/lib/agent-routes";
import { useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import { identityFor } from "@/lib/identity";
import { shouldBlockQueryError } from "@/lib/query-state";
import { relativeTime } from "@/lib/utils";
import { AgentPluginCard } from "./agent-plugin-card";
import {
	type AgentPluginCatalogEntry,
	type AgentPluginInventoryItem,
	agentPluginComponentSummary,
	agentPluginInstallability,
	agentPluginMatches,
	agentPluginStatusPresentation,
	buildAgentPluginInventory,
	pluginDisplayName,
	pluginHasUpdate,
	pluginVersion,
} from "./agent-plugin-model";

const DESIRED_QUERY_KEY = ["get", "/v1/agents/{agent_id}/agent-plugins"] as const;

type PendingPluginMutation = {
	name: string;
	action: "install" | "remove";
} | null;

export function AgentPluginsSurface({
	agentId,
	runtime,
	routeSearch,
	pluginName,
}: {
	agentId: string;
	runtime: HostedRuntime;
	routeSearch?: AgentRouteQuery;
	pluginName?: string;
}) {
	const api = useOpenApi();
	const queryClient = useQueryClient();
	const router = useRouter();
	const mutationLockRef = useRef(false);
	const [pending, setPending] = useState<PendingPluginMutation>(null);
	const pluginListHref = agentSectionHref(
		agentId,
		"plugins",
		agentDeploymentRouteQuery(routeSearch),
	);
	const catalogQuery = api.useQuery("get", "/v1/plugin-catalog", {});
	const desiredQuery = api.useQuery(
		"get",
		"/v1/agents/{agent_id}/agent-plugins",
		{ params: { path: { agent_id: agentId } } },
		{
			refetchInterval: (query) =>
				query.state.data?.plugins.some((plugin) => plugin.convergence === "not_observed")
					? 5_000
					: false,
			refetchIntervalInBackground: false,
		},
	);
	const installMutation = api.useMutation(
		"put",
		"/v1/agents/{agent_id}/agent-plugins/{plugin_name}",
	);
	const removeMutation = api.useMutation(
		"delete",
		"/v1/agents/{agent_id}/agent-plugins/{plugin_name}",
	);

	const refreshDesired = () => queryClient.invalidateQueries({ queryKey: DESIRED_QUERY_KEY });
	const install = async (item: AgentPluginInventoryItem) => {
		if (!item.catalog || mutationLockRef.current) return;
		mutationLockRef.current = true;
		setPending({ name: item.name, action: "install" });
		try {
			await installMutation.mutateAsync({
				params: { path: { agent_id: agentId, plugin_name: item.name } },
				body: { version: item.catalog.version },
			});
			await refreshDesired();
			toast.success(
				pluginHasUpdate(item) ? "Plugin update requested" : "Plugin install requested",
				{
					description: "The agent will apply this desired state automatically.",
				},
			);
		} catch (error) {
			toast.error(pluginHasUpdate(item) ? "Couldn't update plugin" : "Couldn't install plugin", {
				description: normalizeApiError(error),
			});
			throw error;
		} finally {
			mutationLockRef.current = false;
			setPending(null);
		}
	};
	const remove = async (item: AgentPluginInventoryItem) => {
		if (!item.desired || mutationLockRef.current) return;
		mutationLockRef.current = true;
		setPending({ name: item.name, action: "remove" });
		try {
			await removeMutation.mutateAsync({
				params: { path: { agent_id: agentId, plugin_name: item.name } },
			});
			await refreshDesired();
			toast.success("Plugin removal requested", {
				description: "The agent will remove it on the next reconciliation.",
			});
			if (pluginName) void router.navigate({ href: pluginListHref });
		} catch (error) {
			toast.error("Couldn't remove plugin", { description: normalizeApiError(error) });
			throw error;
		} finally {
			mutationLockRef.current = false;
			setPending(null);
		}
	};

	const catalogError = shouldBlockQueryError(catalogQuery.error, catalogQuery.data)
		? catalogQuery.error
		: null;
	const desiredError = shouldBlockQueryError(desiredQuery.error, desiredQuery.data)
		? desiredQuery.error
		: null;
	const inventory = useMemo(
		() =>
			buildAgentPluginInventory(catalogQuery.data?.plugins ?? [], desiredQuery.data?.plugins ?? []),
		[catalogQuery.data?.plugins, desiredQuery.data?.plugins],
	);

	if (pluginName) {
		const item = [...inventory.installed, ...inventory.available].find(
			(candidate) => candidate.name === pluginName,
		);
		return (
			<div data-hosted="true" data-v2="true" className="contents">
				<AgentPluginDetail
					agentId={agentId}
					runtime={runtime}
					routeSearch={routeSearch}
					pluginName={pluginName}
					item={item ?? null}
					catalogLoaded={catalogQuery.data !== undefined}
					desiredLoaded={desiredQuery.data !== undefined}
					catalogError={catalogError}
					desiredError={desiredError}
					pending={pending}
					onInstall={install}
					onRemove={remove}
					onRetry={() => {
						void Promise.all([catalogQuery.refetch(), desiredQuery.refetch()]);
					}}
				/>
			</div>
		);
	}

	return (
		<div data-hosted="true" data-v2="true" className="contents">
			<AgentPluginCatalog
				agentId={agentId}
				runtime={runtime}
				routeSearch={routeSearch}
				inventory={inventory}
				catalogLoading={catalogQuery.isLoading}
				desiredLoading={desiredQuery.isLoading}
				catalogError={catalogError}
				desiredError={desiredError}
				pending={pending}
				onInstall={install}
				onRemove={remove}
				onRetryCatalog={() => void catalogQuery.refetch()}
				onRetryDesired={() => void desiredQuery.refetch()}
			/>
		</div>
	);
}

function AgentPluginCatalog({
	agentId,
	runtime,
	routeSearch,
	inventory,
	catalogLoading,
	desiredLoading,
	catalogError,
	desiredError,
	pending,
	onInstall,
	onRemove,
	onRetryCatalog,
	onRetryDesired,
}: {
	agentId: string;
	runtime: HostedRuntime;
	routeSearch?: AgentRouteQuery;
	inventory: { installed: AgentPluginInventoryItem[]; available: AgentPluginInventoryItem[] };
	catalogLoading: boolean;
	desiredLoading: boolean;
	catalogError: unknown | null;
	desiredError: unknown | null;
	pending: PendingPluginMutation;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetryCatalog: () => void;
	onRetryDesired: () => void;
}) {
	const [query, setQuery] = useState("");
	const installed = inventory.installed.filter((item) => agentPluginMatches(item, query));
	const available = inventory.available.filter((item) => agentPluginMatches(item, query));
	const total = inventory.installed.length + inventory.available.length;
	const isInitialLoading = (catalogLoading || desiredLoading) && total === 0;
	const noMatches = Boolean(query.trim()) && installed.length === 0 && available.length === 0;

	if (desiredError) {
		return (
			<ApiErrorPanel
				error={desiredError}
				onRetry={onRetryDesired}
				title="Couldn't load installed plugins"
			/>
		);
	}
	if (isInitialLoading) return <AgentPluginGridSkeleton />;
	if (total === 0 && !catalogError) {
		return (
			<EmptyState
				icon={Blocks}
				title="No plugins available"
				description="New plugins will appear here after the Store catalog syncs them."
			/>
		);
	}

	return (
		<div className="space-y-6" data-testid="agent-plugins-surface">
			{total > 0 ? (
				<ListToolbar
					search={
						<SearchInput
							value={query}
							onChange={setQuery}
							placeholder="Search plugins…"
							ariaLabel="Search plugins"
						/>
					}
				/>
			) : null}
			{installed.length > 0 ? (
				<PluginSection label="Installed" count={installed.length}>
					{installed.map((item) => (
						<AgentPluginCard
							key={item.name}
							item={item}
							agentId={agentId}
							runtime={runtime}
							routeSearch={routeSearch}
							pendingAction={pending?.name === item.name ? pending.action : null}
							mutationsBlocked={pending !== null}
							onInstall={onInstall}
							onRemove={onRemove}
						/>
					))}
				</PluginSection>
			) : null}
			{catalogError ? (
				<ApiErrorPanel
					error={catalogError}
					onRetry={onRetryCatalog}
					title="Couldn't load available plugins"
				/>
			) : available.length > 0 ? (
				<PluginSection label="Available" count={available.length}>
					{available.map((item) => (
						<AgentPluginCard
							key={item.name}
							item={item}
							agentId={agentId}
							runtime={runtime}
							routeSearch={routeSearch}
							pendingAction={pending?.name === item.name ? pending.action : null}
							mutationsBlocked={pending !== null}
							onInstall={onInstall}
							onRemove={onRemove}
						/>
					))}
				</PluginSection>
			) : null}
			{noMatches ? (
				<EmptyState
					variant="inset"
					title="No matches"
					description={`Nothing matches “${query.trim()}”.`}
				/>
			) : null}
		</div>
	);
}

function PluginSection({
	label,
	count,
	children,
}: {
	label: string;
	count: number;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-3">
			<SectionLabel count={count}>{label}</SectionLabel>
			<div className={HERO_GRID_CLASS}>{children}</div>
		</section>
	);
}

function AgentPluginGridSkeleton() {
	return (
		<div className={HERO_GRID_CLASS}>
			<span className="sr-only">Loading plugins</span>
			{Array.from({ length: 6 }).map((_, index) => (
				<HeroCardSkeleton key={`plugin-skeleton-${index}`} compact />
			))}
		</div>
	);
}

function AgentPluginDetail({
	agentId,
	runtime,
	routeSearch,
	pluginName,
	item,
	catalogLoaded,
	desiredLoaded,
	catalogError,
	desiredError,
	pending,
	onInstall,
	onRemove,
	onRetry,
}: {
	agentId: string;
	runtime: HostedRuntime;
	routeSearch?: AgentRouteQuery;
	pluginName: string;
	item: AgentPluginInventoryItem | null;
	catalogLoaded: boolean;
	desiredLoaded: boolean;
	catalogError: unknown | null;
	desiredError: unknown | null;
	pending: PendingPluginMutation;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetry: () => void;
}) {
	const listHref = agentSectionHref(agentId, "plugins", agentDeploymentRouteQuery(routeSearch));
	const title = item ? pluginDisplayName(item) : pluginName;
	useSetBreadcrumbTitle(item ? title : null);

	const loading = (!catalogLoaded && !catalogError) || (!desiredLoaded && !desiredError);
	if (loading) {
		return (
			<div className="space-y-5">
				<DetailBackLink href={listHref} label="Plugins" mobileOnly={false} />
				<PageHeaderSkeleton icon actions />
			</div>
		);
	}
	if (!item && (catalogError || desiredError)) {
		return (
			<div className="space-y-5">
				<DetailBackLink href={listHref} label="Plugins" mobileOnly={false} />
				<ApiErrorPanel
					error={catalogError ?? desiredError}
					onRetry={onRetry}
					title="Couldn't load plugin"
				/>
			</div>
		);
	}
	if (!item) {
		return (
			<div className="space-y-5">
				<DetailBackLink href={listHref} label="Plugins" mobileOnly={false} />
				<DetailNotFound
					title="Plugin not found"
					message="This plugin is not in the current Store or the agent's desired state."
				/>
			</div>
		);
	}

	const identity = identityFor(item.name);
	const status = item.desired ? agentPluginStatusPresentation(item.desired) : null;
	const installability = item.catalog ? agentPluginInstallability(item.catalog, runtime) : null;
	const canInstall = Boolean(
		!desiredError &&
			item.catalog &&
			installability?.installable &&
			(!item.desired || pluginHasUpdate(item)),
	);
	const pendingAction = pending?.name === item.name ? pending.action : null;
	return (
		<div className="space-y-5" data-testid="agent-plugin-detail">
			<DetailBackLink href={listHref} label="Plugins" />
			{catalogError || desiredError ? (
				<ApiErrorPanel
					error={catalogError ?? desiredError}
					onRetry={onRetry}
					title="Some plugin details are unavailable"
				/>
			) : null}
			<PageHeader
				title={title}
				icon={
					<IconChip tint={identity.colorClasses}>
						<Blocks />
					</IconChip>
				}
				description={
					item.catalog?.description ??
					"This installed version is no longer listed in the current Store catalog."
				}
				titleAdornment={
					status ? (
						<StatusBadge status={status.tone} withDot>
							{status.label}
						</StatusBadge>
					) : undefined
				}
				status={
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
						<span>v{pluginVersion(item)}</span>
						{item.catalog?.publisher ? (
							<>
								<span>·</span>
								<span>{item.catalog.publisher}</span>
							</>
						) : null}
						{item.desired?.observed_at ? (
							<>
								<span>·</span>
								<span>observed {relativeTime(item.desired.observed_at)}</span>
							</>
						) : null}
					</div>
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
			) : !item.desired && installability?.reason ? (
				<Alert>
					<Blocks />
					<AlertTitle>{installability.label}</AlertTitle>
					<AlertDescription>{installability.reason}</AlertDescription>
				</Alert>
			) : null}

			<DetailStats>
				<Stat icon={Tag} label={`v${pluginVersion(item)}`} />
				<Stat
					icon={BookOpen}
					label={`${item.catalog?.components.skills.length ?? 0} Skill${item.catalog?.components.skills.length === 1 ? "" : "s"}`}
				/>
				<Stat
					icon={Server}
					label={`${Object.keys(item.catalog?.components.mcpServers ?? {}).length} MCP server${Object.keys(item.catalog?.components.mcpServers ?? {}).length === 1 ? "" : "s"}`}
				/>
			</DetailStats>

			<PluginComponentsPanel entry={item.catalog} />
			{item.catalog ? <PluginStoreDetails entry={item.catalog} /> : null}
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
	pendingAction: "install" | "remove" | null;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
}) {
	return (
		<>
			{canInstall ? (
				<Button
					size="sm"
					variant={pluginHasUpdate(item) ? "outline" : "default"}
					disabled={pendingAction !== null}
					onClick={() => void onInstall(item).catch(() => undefined)}
				>
					{pendingAction === "install" ? (
						<Spinner />
					) : pluginHasUpdate(item) ? (
						<RefreshCw />
					) : (
						<Plus />
					)}
					{pluginHasUpdate(item) ? `Update to v${item.catalog?.version}` : "Install"}
				</Button>
			) : !item.desired && installability ? (
				<Button size="sm" variant="outline" disabled title={installability.reason ?? undefined}>
					{installability.label}
				</Button>
			) : null}
			{item.desired ? (
				<ConfirmAction
					title={`Remove ${pluginDisplayName(item)}?`}
					description={
						<p>The agent will remove this plugin the next time it reconciles desired state.</p>
					}
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
						Remove
					</Button>
				</ConfirmAction>
			) : null}
		</>
	);
}

function PluginComponentsPanel({ entry }: { entry: AgentPluginCatalogEntry | null }) {
	const mcpServers = Object.entries(entry?.components.mcpServers ?? {}).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return (
		<DetailPanel className="space-y-4">
			<div>
				<div className="flex items-center gap-2">
					<Box className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">Components</h2>
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					{agentPluginComponentSummary(entry)} provided through the Agent Plugins package.
				</p>
			</div>
			{entry ? (
				<div className="divide-y">
					{entry.components.skills.map((skill) => (
						<ComponentRow key={`skill:${skill}`} icon={BookOpen} label="Skill" name={skill} />
					))}
					{mcpServers.map(([name, transport]) => (
						<ComponentRow
							key={`mcp:${name}`}
							icon={Server}
							label="MCP server"
							name={name}
							meta={transportLabel(transport)}
						/>
					))}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">
					Component metadata is unavailable for this historical installation.
				</p>
			)}
		</DetailPanel>
	);
}

function ComponentRow({
	icon: Icon,
	label,
	name,
	meta,
}: {
	icon: typeof BookOpen;
	label: string;
	name: string;
	meta?: string;
}) {
	return (
		<div className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
			<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<div className="text-xs text-muted-foreground">{label}</div>
				<code className="mt-0.5 block break-all text-sm">{name}</code>
			</div>
			{meta ? <Badge variant="outline">{meta}</Badge> : null}
		</div>
	);
}

function PluginStoreDetails({ entry }: { entry: AgentPluginCatalogEntry }) {
	return (
		<DetailPanel className="space-y-4">
			<div className="flex items-center gap-2">
				<Blocks className="size-4 text-muted-foreground" />
				<h2 className="text-sm font-semibold">Store details</h2>
			</div>
			<dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
				<DetailValue label="Package" value={entry.name} mono />
				<DetailValue label="Category" value={entry.category} />
				<DetailValue label="Runtimes" value={entry.runtimes.map(runtimeDisplayName).join(", ")} />
				<DetailValue
					label="Languages"
					value={entry.languages.join(", ") || "Not specified"}
					icon={Languages}
				/>
			</dl>
			{entry.keywords.length > 0 ? (
				<div>
					<div className="text-xs text-muted-foreground">Keywords</div>
					<div className="mt-2 flex flex-wrap gap-1.5">
						{entry.keywords.map((keyword) => (
							<Badge key={keyword} variant="secondary">
								{keyword}
							</Badge>
						))}
					</div>
				</div>
			) : null}
		</DetailPanel>
	);
}

function DetailValue({
	label,
	value,
	mono = false,
	icon: Icon,
}: {
	label: string;
	value: string;
	mono?: boolean;
	icon?: typeof Languages;
}) {
	return (
		<div className="min-w-0">
			<dt className="flex items-center gap-1 text-xs text-muted-foreground">
				{Icon ? <Icon className="size-3.5" /> : null}
				{label}
			</dt>
			<dd className={mono ? "mt-1 break-all font-mono text-xs" : "mt-1 break-words"}>{value}</dd>
		</div>
	);
}

function transportLabel(transport: "stdio" | "streamable-http" | "sse"): string {
	if (transport === "streamable-http") return "Streamable HTTP";
	return transport === "sse" ? "SSE" : "stdio";
}
