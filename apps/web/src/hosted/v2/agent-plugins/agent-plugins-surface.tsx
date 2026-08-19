"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useRouter } from "@tanstack/react-router";
import { AlertCircle, Blocks, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbSegmentTitle } from "@/components/breadcrumb-title";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS, HeroCardSkeleton } from "@/components/entity-card";
import { FilterChip } from "@/components/filter-chip";
import { IconChip } from "@/components/icon-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import type { HostedRuntime } from "@/hosted/runtimes";
import { agentPluginDetailHref, agentSectionHref, parseAgentPathname } from "@/lib/agent-routes";
import { useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import { shouldBlockQueryError } from "@/lib/query-state";
import { AgentPluginCard, type AgentPluginPendingAction } from "./agent-plugin-card";
import { AgentPluginDetail } from "./agent-plugin-detail";
import {
	type AgentPluginGroup,
	type AgentPluginInventoryItem,
	agentPluginInstallability,
	agentPluginIsStalled,
	agentPluginMatches,
	assignAgentPluginGroups,
	buildAgentPluginInventory,
	pluginDisplayName,
	pluginHasUpdate,
} from "./agent-plugin-model";

const DESIRED_QUERY_KEY = ["get", "/v1/agents/{agent_id}/agent-plugins"] as const;

type PendingPluginMutation = {
	name: string;
	action: Exclude<AgentPluginPendingAction, null>;
} | null;

export function AgentPluginsSurface({
	agentId,
	runtime,
}: {
	agentId: string;
	runtime: HostedRuntime;
}) {
	const api = useOpenApi();
	const queryClient = useQueryClient();
	const router = useRouter();
	const pathname = useLocation({ select: (location) => location.pathname });
	const selectedPlugin = parseAgentPathname(pathname)?.pluginName ?? null;
	const mutationLock = useRef(false);
	const [pending, setPending] = useState<PendingPluginMutation>(null);
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState("all");
	const groupState = useRef<{
		agentId: string;
		assignments: ReadonlyMap<string, AgentPluginGroup>;
	}>({ agentId, assignments: new Map() });
	if (groupState.current.agentId !== agentId) {
		groupState.current = { agentId, assignments: new Map() };
	}
	const convergenceLog = useRef<{ agentId: string; seen: Map<string, string> }>({
		agentId,
		seen: new Map(),
	});
	if (convergenceLog.current.agentId !== agentId) {
		convergenceLog.current = { agentId, seen: new Map() };
	}
	const catalogQuery = api.useQuery("get", "/v1/plugin-catalog", {});
	const desiredQuery = api.useQuery(
		"get",
		"/v1/agents/{agent_id}/agent-plugins",
		{ params: { path: { agent_id: agentId } } },
		{
			refetchInterval: (query) => {
				const plugins = query.state.data?.plugins;
				if (!plugins?.some((plugin) => plugin.convergence === "not_observed")) return false;
				const now = new Date();
				return plugins.some(
					(plugin) => plugin.convergence === "not_observed" && !agentPluginIsStalled(plugin, now),
				)
					? 5_000
					: 60_000;
			},
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
	const openPlugin = (name: string) => {
		void router
			.navigate({ href: agentPluginDetailHref(agentId, name), resetScroll: false })
			.catch(() => toast.error("Couldn't open plugin details"));
	};
	const closePlugin = () => {
		void router
			.navigate({ href: agentSectionHref(agentId, "plugins"), replace: true, resetScroll: false })
			.catch(() => toast.error("Couldn't return to plugins"));
	};
	const install = async (item: AgentPluginInventoryItem) => {
		if (!item.catalog || mutationLock.current) return;
		mutationLock.current = true;
		setPending({ name: item.name, action: "install" });
		const updating = pluginHasUpdate(item);
		try {
			await installMutation.mutateAsync({
				params: { path: { agent_id: agentId, plugin_name: item.name } },
				body: { version: item.catalog.version },
			});
			await refreshDesired();
			toast.success(updating ? "Plugin update started" : "Plugin installation started");
		} catch (error) {
			toast.error(updating ? "Couldn't update plugin" : "Couldn't install plugin", {
				description: normalizeApiError(error),
			});
			throw error;
		} finally {
			mutationLock.current = false;
			setPending(null);
		}
	};
	const remove = async (item: AgentPluginInventoryItem) => {
		if (!item.desired || mutationLock.current) return;
		mutationLock.current = true;
		setPending({ name: item.name, action: "remove" });
		try {
			await removeMutation.mutateAsync({
				params: { path: { agent_id: agentId, plugin_name: item.name } },
			});
			await refreshDesired();
			toast.success("Plugin removal started");
			if (selectedPlugin === item.name) closePlugin();
		} catch (error) {
			toast.error("Couldn't remove plugin", { description: normalizeApiError(error) });
			throw error;
		} finally {
			mutationLock.current = false;
			setPending(null);
		}
	};
	const retry = async (item: AgentPluginInventoryItem) => {
		if (
			!item.catalog ||
			item.desired?.convergence !== "failed" ||
			!agentPluginInstallability(item.catalog, runtime).installable ||
			mutationLock.current
		) {
			return;
		}
		mutationLock.current = true;
		setPending({ name: item.name, action: "retry" });
		try {
			await removeMutation.mutateAsync({
				params: { path: { agent_id: agentId, plugin_name: item.name } },
			});
			await installMutation.mutateAsync({
				params: { path: { agent_id: agentId, plugin_name: item.name } },
				body: { version: item.catalog.version },
			});
			await refreshDesired();
			toast.success("Plugin retry started");
		} catch (error) {
			toast.error("Couldn't retry plugin", { description: normalizeApiError(error) });
			void refreshDesired();
			throw error;
		} finally {
			mutationLock.current = false;
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
			buildAgentPluginInventory(
				catalogQuery.data?.plugins ?? [],
				desiredError ? [] : (desiredQuery.data?.plugins ?? []),
			),
		[catalogQuery.data?.plugins, desiredError, desiredQuery.data?.plugins],
	);
	const initialLoading =
		(desiredQuery.data === undefined && !desiredError) ||
		(catalogQuery.data === undefined && !catalogError);
	if (!initialLoading) {
		groupState.current.assignments = assignAgentPluginGroups(
			groupState.current.assignments,
			inventory,
		);
	}
	const selectedItem =
		!initialLoading && selectedPlugin
			? inventory.find((item) => item.name === selectedPlugin)
			: null;
	useSetBreadcrumbSegmentTitle(
		selectedItem ? agentPluginDetailHref(agentId, selectedItem.name) : null,
		selectedItem ? pluginDisplayName(selectedItem) : null,
	);
	const categories = useMemo(
		() =>
			[
				...new Set(
					(catalogQuery.data?.plugins ?? []).map((entry) => entry.category).filter(Boolean),
				),
			].sort((left, right) => left.localeCompare(right)),
		[catalogQuery.data?.plugins],
	);
	const selectedCategory = category === "all" || categories.includes(category) ? category : "all";

	useEffect(() => {
		const plugins = desiredQuery.data?.plugins;
		if (!plugins) return;
		const seen = convergenceLog.current.seen;
		const live = new Set<string>();
		for (const plugin of plugins) {
			live.add(plugin.installation_id);
			const previous = seen.get(plugin.installation_id);
			seen.set(plugin.installation_id, plugin.convergence);
			if (previous !== "not_observed" || plugin.convergence === "not_observed") continue;
			const title =
				catalogQuery.data?.plugins.find((entry) => entry.name === plugin.plugin_name)
					?.display_name ?? plugin.plugin_name;
			if (plugin.convergence === "installed") {
				toast.success(`${title} is ready to use`);
			} else {
				toast.error(`${title} installation failed`, {
					description: "Open the plugin to retry or remove it.",
				});
			}
		}
		for (const id of seen.keys()) {
			if (!live.has(id)) seen.delete(id);
		}
	}, [desiredQuery.data, catalogQuery.data]);

	return (
		<div data-hosted="true" data-v2="true" className="space-y-6">
			{selectedItem ? (
				<AgentPluginDetail
					item={selectedItem}
					runtime={runtime}
					catalogError={catalogError}
					pendingAction={pending?.name === selectedItem.name ? pending.action : null}
					desiredStateError={desiredError !== null}
					desiredStateRetrying={desiredQuery.isFetching}
					onBack={closePlugin}
					onInstall={install}
					onRemove={remove}
					onRetry={retry}
					onRetryCatalog={() => void catalogQuery.refetch()}
					onRetryDesired={() => void desiredQuery.refetch()}
				/>
			) : (
				<>
					<PageHeader
						title="Plugins"
						description="Add tools and knowledge to this agent."
						icon={
							<IconChip tint="bg-identity-7-bg text-identity-7-fg">
								<Blocks />
							</IconChip>
						}
					/>
					{initialLoading ? (
						<AgentPluginGridSkeleton />
					) : (
						<AgentPluginCatalog
							inventory={inventory}
							runtime={runtime}
							catalogError={catalogError}
							desiredError={desiredError}
							desiredRetrying={desiredQuery.isFetching}
							pending={pending}
							query={query}
							categories={categories}
							category={selectedCategory}
							groupAssignments={groupState.current.assignments}
							onQueryChange={setQuery}
							onCategoryChange={setCategory}
							onOpen={openPlugin}
							onInstall={install}
							onRemove={remove}
							onRetry={retry}
							onRetryCatalog={() => void catalogQuery.refetch()}
							onRetryDesired={() => void desiredQuery.refetch()}
						/>
					)}
				</>
			)}
		</div>
	);
}

function AgentPluginCatalog({
	inventory,
	runtime,
	catalogError,
	desiredError,
	desiredRetrying,
	pending,
	query,
	categories,
	category,
	groupAssignments,
	onQueryChange,
	onCategoryChange,
	onOpen,
	onInstall,
	onRemove,
	onRetry,
	onRetryCatalog,
	onRetryDesired,
}: {
	inventory: AgentPluginInventoryItem[];
	runtime: HostedRuntime;
	catalogError: unknown | null;
	desiredError: unknown | null;
	desiredRetrying: boolean;
	pending: PendingPluginMutation;
	query: string;
	categories: string[];
	category: string;
	groupAssignments: ReadonlyMap<string, AgentPluginGroup>;
	onQueryChange: (query: string) => void;
	onCategoryChange: (category: string) => void;
	onOpen: (name: string) => void;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetry: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetryCatalog: () => void;
	onRetryDesired: () => void;
}) {
	const items = inventory.filter(
		(item) =>
			(category === "all" || item.catalog?.category === category) &&
			agentPluginMatches(item, query),
	);
	const groups = [
		{
			id: "installed" as const,
			label: "Installed",
			items: items.filter((item) => groupAssignments.get(item.name) === "installed"),
		},
		{
			id: "available" as const,
			label: "Available",
			items: items.filter((item) => groupAssignments.get(item.name) === "available"),
		},
	];
	const noMatches = (Boolean(query.trim()) || category !== "all") && items.length === 0;

	if (inventory.length === 0) {
		return catalogError ? (
			<ApiErrorPanel
				error={catalogError}
				onRetry={onRetryCatalog}
				title="Couldn't load available plugins"
			/>
		) : desiredError ? (
			<ApiErrorPanel
				error={desiredError}
				onRetry={onRetryDesired}
				title="Couldn't load installed plugins"
			/>
		) : (
			<EmptyState icon={Blocks} title="No plugins available" />
		);
	}

	return (
		<div className="space-y-6" data-testid="agent-plugins-surface">
			<ListToolbar
				search={
					<SearchInput
						value={query}
						onChange={onQueryChange}
						placeholder="Search plugins…"
						ariaLabel="Search plugins"
					/>
				}
				filters={
					<>
						<FilterChip active={category === "all"} onClick={() => onCategoryChange("all")}>
							All
							<span className="text-muted-foreground tabular-nums">{inventory.length}</span>
						</FilterChip>
						{categories.map((value) => (
							<FilterChip
								key={value}
								active={category === value}
								onClick={() => onCategoryChange(value)}
							>
								{value}
								<span className="text-muted-foreground tabular-nums">
									{inventory.filter((item) => item.catalog?.category === value).length}
								</span>
							</FilterChip>
						))}
					</>
				}
			/>
			{desiredError ? (
				<DesiredStateErrorAlert isRetrying={desiredRetrying} onRetry={onRetryDesired} />
			) : null}
			{catalogError ? (
				<ApiErrorPanel
					error={catalogError}
					onRetry={onRetryCatalog}
					title="Couldn't load available plugins"
				/>
			) : null}
			{groups.map((group) =>
				group.items.length > 0 ? (
					<section key={group.id} className="space-y-3">
						<SectionLabel count={group.items.length}>{group.label}</SectionLabel>
						<div className={HERO_GRID_CLASS}>
							{group.items.map((item) => (
								<AgentPluginCard
									key={item.name}
									item={item}
									runtime={runtime}
									pendingAction={pending?.name === item.name ? pending.action : null}
									mutationsBlocked={pending !== null}
									onOpen={onOpen}
									onInstall={onInstall}
									onRemove={onRemove}
									onRetry={onRetry}
								/>
							))}
						</div>
					</section>
				) : null,
			)}
			{noMatches ? (
				<EmptyState
					variant="inset"
					title="No plugins found"
					description="Try a different search or category."
				/>
			) : null}
		</div>
	);
}

function DesiredStateErrorAlert({
	isRetrying,
	onRetry,
}: {
	isRetrying: boolean;
	onRetry: () => void;
}) {
	return (
		<Alert>
			<AlertCircle />
			<AlertTitle>Couldn't load installed plugins</AlertTitle>
			<AlertDescription>Showing Store plugins without installed status.</AlertDescription>
			<AlertAction>
				<Button size="sm" variant="outline" disabled={isRetrying} onClick={onRetry}>
					{isRetrying ? <Spinner /> : <RefreshCw />}
					Retry
				</Button>
			</AlertAction>
		</Alert>
	);
}

function AgentPluginGridSkeleton() {
	return (
		<div className={HERO_GRID_CLASS}>
			<span className="sr-only">Loading plugins</span>
			{Array.from({ length: 4 }).map((_, index) => (
				<HeroCardSkeleton key={`plugin-skeleton-${index}`} compact />
			))}
		</div>
	);
}
