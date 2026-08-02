"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import {
	OverviewModuleError,
	OverviewModuleSkeleton,
	OverviewSummaryRows,
} from "@/components/dashboard/agent-overview-capabilities";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchAgentProjectVaults } from "@/components/vault/vault-scope";
import { unwrap, useApi } from "@/lib/api";
import { useAvailableApps, useConnectedAppCards } from "@/lib/connectors-data";

export function OverviewMemoriesBody() {
	const api = useApi();
	const query = useQuery({
		queryKey: ["memories", "", "", 0, 1],
		queryFn: async () =>
			unwrap(await api.GET("/v1/memories", { params: { query: { page: 1, page_size: 1 } } })),
	});
	if (query.isLoading) return <OverviewModuleSkeleton label="memories" rows={1} />;
	if (query.error)
		return <OverviewModuleError label="Memories" onRetry={() => void query.refetch()} />;
	const total = query.data?.total ?? 0;
	return (
		<p className="text-lg font-semibold">
			{total ? `${total} ${total === 1 ? "memory" : "memories"}` : "No memories yet"}
		</p>
	);
}

export function OverviewVaultsBody({
	projectIds,
	isLoading,
	error,
	onRetry,
}: {
	projectIds: readonly string[];
	isLoading: boolean;
	error: unknown;
	onRetry: () => void;
}) {
	const api = useApi();
	const query = useQuery({
		queryKey: ["vaults", "agent-projects", ...projectIds],
		queryFn: async () =>
			fetchAgentProjectVaults(projectIds, async (projectId, page, pageSize) =>
				unwrap(
					await api.GET("/v1/vault", {
						params: { query: { project_id: projectId, page, page_size: pageSize } },
					}),
				),
			),
		enabled: !isLoading && !error && projectIds.length > 0,
	});
	if (isLoading || query.isLoading) return <OverviewModuleSkeleton label="vaults" rows={2} />;
	if (error) return <OverviewModuleError label="Vaults" onRetry={onRetry} />;
	if (query.error)
		return <OverviewModuleError label="Vaults" onRetry={() => void query.refetch()} />;
	const vaults = query.data ?? [];
	return (
		<div className="space-y-3">
			<p className="text-lg font-semibold">
				{vaults.length
					? `${vaults.length} ${vaults.length === 1 ? "vault" : "vaults"}`
					: "No vaults available"}
			</p>
			{vaults.length ? (
				<OverviewSummaryRows
					items={vaults.map((vault) => vault.name)}
					empty="No vaults available"
				/>
			) : null}
		</div>
	);
}

export function OverviewConnectorsBody() {
	const connected = useConnectedAppCards();
	const catalog = useAvailableApps({ page: 1, pageSize: 8 });
	const connectedNames = new Set(
		connected.activeConnections.flatMap((connection) =>
			connection.app_name ? [connection.app_name] : [],
		),
	);
	const connectedAppCount = connectedNames.size;
	const popular = (catalog.data?.items ?? [])
		.filter((app) => !connectedNames.has(app.name))
		.slice(0, 5);
	return (
		<div className="space-y-3">
			{connected.isLoading ? (
				<ConnectorRailSkeleton label="Connected" />
			) : connected.connectionsError ? (
				<OverviewModuleError label="Connected apps" onRetry={connected.refetch} />
			) : (
				<div className="space-y-3">
					<p className="text-lg font-semibold">
						{connectedAppCount
							? `${connectedAppCount} connected ${connectedAppCount === 1 ? "app" : "apps"}`
							: "No apps connected"}
					</p>
					{connected.data.length ? (
						<ConnectorRail label="Connected" apps={connected.data.slice(0, 6)} />
					) : null}
					{connected.metadataError ? (
						<p className="text-xs text-muted-foreground">Some app icons can’t be shown.</p>
					) : null}
				</div>
			)}
			{catalog.isLoading ? (
				<ConnectorRailSkeleton label="Popular" />
			) : catalog.error ? (
				<OverviewModuleError label="Popular apps" onRetry={() => void catalog.refetch()} />
			) : popular.length ? (
				<ConnectorRail label="Popular" apps={popular} />
			) : null}
		</div>
	);
}

function ConnectorRailSkeleton({ label }: { label: string }) {
	return (
		<div aria-label={`Loading ${label.toLowerCase()} apps`} role="status">
			<p className="mb-2 text-xs text-muted-foreground">{label}</p>
			<div className="flex gap-2">
				{Array.from({ length: 5 }).map((_, index) => (
					<Skeleton key={index} className="size-9 rounded-lg" />
				))}
			</div>
		</div>
	);
}

function ConnectorRail({
	label,
	apps,
}: {
	label: string;
	apps: readonly { name: string; display_name: string; logo: string }[];
}) {
	return (
		<div>
			<p className="mb-2 text-xs text-muted-foreground">{label}</p>
			<div className="flex flex-wrap gap-2">
				{apps.map((app) => (
					<Link
						key={app.name}
						to="/connectors/$name"
						params={{ name: app.name }}
						aria-label={`${label}: ${app.display_name}`}
						title={app.display_name}
					>
						<ConnectorIcon name={app.display_name} logo={app.logo} size="sm" />
					</Link>
				))}
			</div>
		</div>
	);
}
