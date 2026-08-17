"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Blocks } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS, HeroCardSkeleton } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { SearchInput } from "@/components/ui/search-input";
import type { HostedRuntime } from "@/hosted/runtimes";
import { useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import { shouldBlockQueryError } from "@/lib/query-state";
import { AgentPluginCard, type AgentPluginPendingAction } from "./agent-plugin-card";
import { AgentPluginDetail } from "./agent-plugin-detail";
import {
	type AgentPluginInventoryItem,
	agentPluginMatches,
	buildAgentPluginInventory,
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
	const mutationLock = useRef(false);
	const [pending, setPending] = useState<PendingPluginMutation>(null);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [query, setQuery] = useState("");
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
			toast.success(updating ? "Update requested" : "Install requested");
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
			setSelectedName(null);
			toast.success("Removal requested");
		} catch (error) {
			toast.error("Couldn't remove plugin", { description: normalizeApiError(error) });
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
			buildAgentPluginInventory(catalogQuery.data?.plugins ?? [], desiredQuery.data?.plugins ?? []),
		[catalogQuery.data?.plugins, desiredQuery.data?.plugins],
	);
	const selectedItem = selectedName
		? [...inventory.installed, ...inventory.available].find((item) => item.name === selectedName)
		: null;
	const initialLoading =
		(desiredQuery.data === undefined && !desiredError) ||
		(catalogQuery.data === undefined && !catalogError);

	return (
		<div data-hosted="true" data-v2="true" className="space-y-6">
			{selectedItem ? (
				<AgentPluginDetail
					item={selectedItem}
					runtime={runtime}
					catalogError={catalogError}
					pendingAction={pending?.name === selectedItem.name ? pending.action : null}
					onBack={() => setSelectedName(null)}
					onInstall={install}
					onRemove={remove}
					onRetryCatalog={() => void catalogQuery.refetch()}
				/>
			) : (
				<>
					<PageHeader
						title="Plugins"
						description="Install Skills and MCP servers from the Store for this agent."
						icon={
							<IconChip tint="bg-identity-7-bg text-identity-7-fg">
								<Blocks />
							</IconChip>
						}
					/>
					{desiredError ? (
						<ApiErrorPanel
							error={desiredError}
							onRetry={() => void desiredQuery.refetch()}
							title="Couldn't load installed plugins"
						/>
					) : initialLoading ? (
						<AgentPluginGridSkeleton />
					) : (
						<AgentPluginCatalog
							inventory={inventory}
							runtime={runtime}
							catalogError={catalogError}
							pending={pending}
							query={query}
							onQueryChange={setQuery}
							onOpen={setSelectedName}
							onInstall={install}
							onRemove={remove}
							onRetryCatalog={() => void catalogQuery.refetch()}
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
	pending,
	query,
	onQueryChange,
	onOpen,
	onInstall,
	onRemove,
	onRetryCatalog,
}: {
	inventory: { installed: AgentPluginInventoryItem[]; available: AgentPluginInventoryItem[] };
	runtime: HostedRuntime;
	catalogError: unknown | null;
	pending: PendingPluginMutation;
	query: string;
	onQueryChange: (query: string) => void;
	onOpen: (name: string) => void;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetryCatalog: () => void;
}) {
	const installed = inventory.installed.filter((item) => agentPluginMatches(item, query));
	const available = inventory.available.filter((item) => agentPluginMatches(item, query));
	const total = inventory.installed.length + inventory.available.length;
	const noMatches = Boolean(query.trim()) && installed.length === 0 && available.length === 0;

	if (total === 0) {
		return catalogError ? (
			<ApiErrorPanel
				error={catalogError}
				onRetry={onRetryCatalog}
				title="Couldn't load available plugins"
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
			/>
			{installed.length > 0 ? (
				<PluginSection label="Installed" items={installed}>
					{installed.map((item) => (
						<AgentPluginCard
							key={item.name}
							item={item}
							runtime={runtime}
							pendingAction={pending?.name === item.name ? pending.action : null}
							mutationsBlocked={pending !== null}
							onOpen={onOpen}
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
				<PluginSection label="Available" items={available}>
					{available.map((item) => (
						<AgentPluginCard
							key={item.name}
							item={item}
							runtime={runtime}
							pendingAction={pending?.name === item.name ? pending.action : null}
							mutationsBlocked={pending !== null}
							onOpen={onOpen}
							onInstall={onInstall}
							onRemove={onRemove}
						/>
					))}
				</PluginSection>
			) : null}
			{noMatches ? (
				<EmptyState
					variant="inset"
					title="No plugins found"
					description="Try a different search."
				/>
			) : null}
		</div>
	);
}

function PluginSection({
	label,
	items,
	children,
}: {
	label: string;
	items: readonly AgentPluginInventoryItem[];
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-3">
			<SectionLabel count={items.length}>{label}</SectionLabel>
			<div className={HERO_GRID_CLASS}>{children}</div>
		</section>
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
