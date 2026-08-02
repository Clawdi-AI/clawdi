"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleCheck, RefreshCw } from "lucide-react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import {
	OverviewModuleError,
	OverviewModuleSkeleton,
	OverviewSummaryRows,
} from "@/components/dashboard/agent-overview-capabilities";
import { Button } from "@/components/ui/button";
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
	const connectedApps = connected.data.slice(0, 5).map((app) => ({ app, connected: true }));
	const connectionsResolved = !connected.connectionsLoading && !connected.connectionsError;
	const popularApps = (catalog.data?.items ?? [])
		.filter((app) => !connectedNames.has(app.name))
		.slice(0, Math.max(0, 5 - connectedApps.length))
		.map((app) => ({ app, state: connectionsResolved ? "suggested" : "available" }) as const);
	const apps = [
		...connectedApps.map(({ app }) => ({ app, state: "connected" }) as const),
		...popularApps,
	];
	const connectionsUnavailable = Boolean(connected.connectionsError);
	const catalogUnavailable = Boolean(catalog.error);
	const allUnavailable = connectionsUnavailable && catalogUnavailable && apps.length === 0;
	const loadingSlots = Math.max(
		0,
		Math.min(
			5 - apps.length,
			connected.connectionsLoading || connected.metadataLoading || catalog.isLoading ? 3 : 0,
		),
	);
	return (
		<div className="space-y-3">
			{!connected.connectionsLoading && !connectionsUnavailable ? (
				<p className="text-lg font-semibold">
					{connectedAppCount ? `${connectedAppCount} connected` : "No apps connected"}
				</p>
			) : null}
			{allUnavailable ? (
				<OverviewModuleError
					label="Apps"
					onRetry={() => {
						connected.refetch();
						void catalog.refetch();
					}}
				/>
			) : apps.length || loadingSlots ? (
				<ConnectorRail apps={apps} loadingSlots={loadingSlots} />
			) : null}
			{allUnavailable ? null : connected.connectionsLoading ? (
				<span className="sr-only" aria-label="Loading connected apps" role="status" />
			) : connectionsUnavailable ? (
				<ConnectorRetry label="Can’t load connected apps" onRetry={connected.refetch} />
			) : connected.metadataError ? (
				<ConnectorRetry
					label="Some connected app icons can’t be shown"
					onRetry={connected.refetch}
				/>
			) : null}
			{!allUnavailable && catalogUnavailable ? (
				<ConnectorRetry label="Can’t load suggested apps" onRetry={() => void catalog.refetch()} />
			) : null}
		</div>
	);
}

function ConnectorRetry({ label, onRetry }: { label: string; onRetry: () => void }) {
	return (
		<div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
			<span>{label}.</span>
			<Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onRetry}>
				<RefreshCw className="size-3" />
				Retry
			</Button>
		</div>
	);
}

function ConnectorRail({
	apps,
	loadingSlots,
}: {
	apps: readonly {
		app: { name: string; display_name: string; logo: string };
		state: "connected" | "suggested" | "available";
	}[];
	loadingSlots: number;
}) {
	return (
		<div className="flex flex-wrap gap-2" data-testid="overview-connector-rail">
			{apps.map(({ app, state }) => (
				<div key={app.name} className="relative">
					<Link
						to="/connectors/$name"
						params={{ name: app.name }}
						aria-label={`${state[0]?.toUpperCase()}${state.slice(1)} app: ${app.display_name}`}
						title={`${app.display_name}${state === "connected" ? " (connected)" : ""}`}
						className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						<ConnectorIcon name={app.display_name} logo={app.logo} size="sm" />
					</Link>
					{state === "connected" ? (
						<span className="absolute -right-1 -bottom-1 rounded-full bg-background text-primary">
							<CircleCheck className="size-4 fill-background" aria-hidden="true" />
						</span>
					) : null}
				</div>
			))}
			{Array.from({ length: loadingSlots }).map((_, index) => (
				<Skeleton key={index} className="size-9 rounded-lg" aria-label="Loading app" />
			))}
		</div>
	);
}
