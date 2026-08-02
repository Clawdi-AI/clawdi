"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import {
	type AgentOverviewModuleContent,
	OVERVIEW_IDENTITY_RAIL_LIMIT,
	OverviewDescriptionSkeleton,
	OverviewIdentityIconItem,
	OverviewIdentityIconRail,
	OverviewModuleError,
	OverviewModuleSkeleton,
	OverviewResourceDetails,
} from "@/components/dashboard/agent-overview-capabilities";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentProjectVaults } from "@/components/vault/agent-vaults-query";
import { unwrap, useApi } from "@/lib/api";
import { useConnectedAppCards } from "@/lib/connectors-data";

type SummaryState = {
	isLoading: boolean;
	isUnavailable?: boolean;
	error: unknown;
	onRetry: () => void;
};

export function overviewProjectsModule({
	bindings,
	names,
}: {
	bindings: SummaryState & { count: number | null };
	names: SummaryState & { items: readonly string[]; unresolvedCount: number };
}): AgentOverviewModuleContent {
	if (bindings.isLoading)
		return {
			description: <OverviewDescriptionSkeleton label="projects" />,
			body: <OverviewModuleSkeleton label="projects" rows={3} showHeading={false} />,
		};
	if (bindings.isUnavailable) return { description: "Unavailable right now" };
	if (bindings.error)
		return {
			description: "Unavailable right now",
			body: <OverviewModuleError label="Projects" onRetry={bindings.onRetry} />,
		};
	const count = bindings.count ?? 0;
	const primary = count ? `${count} ${count === 1 ? "project" : "projects"}` : "No projects added";
	if (count === 0) return { description: primary };
	if (names.isLoading)
		return {
			description: primary,
			body: (
				<OverviewResourceDetails>
					<OverviewModuleSkeleton label="project names" rows={3} showHeading={false} />
				</OverviewResourceDetails>
			),
		};
	if (names.error)
		return {
			description: primary,
			body: (
				<OverviewResourceDetails>
					<OverviewModuleError label="Project names" onRetry={names.onRetry} />
				</OverviewResourceDetails>
			),
		};
	const unresolvedCopy = names.unresolvedCount
		? `${names.unresolvedCount} project ${names.unresolvedCount === 1 ? "name can’t" : "names can’t"} be shown`
		: "Project names can’t be shown";
	return {
		description: primary,
		body: (
			<OverviewResourceDetails items={names.items}>
				{names.unresolvedCount > 0 || names.items.length === 0 ? (
					<p className="text-sm text-muted-foreground">{unresolvedCopy}</p>
				) : null}
			</OverviewResourceDetails>
		),
	};
}

export function overviewSkillsModule({
	items,
	...state
}: SummaryState & { items: readonly string[] }): AgentOverviewModuleContent {
	if (state.isLoading) return { description: <OverviewDescriptionSkeleton label="skills" /> };
	if (state.isUnavailable) return { description: "Unavailable right now" };
	if (state.error)
		return {
			description: "Unavailable right now",
			body: <OverviewModuleError label="Skills" onRetry={state.onRetry} />,
		};
	return {
		description: items.length
			? `${items.length} ${items.length === 1 ? "skill" : "skills"}`
			: "No skills available",
		body: items.length ? <OverviewResourceDetails items={items} /> : undefined,
	};
}

export function useOverviewMemoriesModule({
	enabled = true,
}: {
	enabled?: boolean;
} = {}): AgentOverviewModuleContent {
	const api = useApi();
	const query = useQuery({
		queryKey: ["memories", "", "", 0, 1],
		queryFn: async () =>
			unwrap(await api.GET("/v1/memories", { params: { query: { page: 1, page_size: 1 } } })),
		enabled,
	});
	if (query.isLoading) return { description: <OverviewDescriptionSkeleton label="memories" /> };
	if (query.error)
		return {
			description: "Unavailable right now",
			body: <OverviewModuleError label="Memories" onRetry={() => void query.refetch()} />,
		};
	const total = query.data?.total ?? 0;
	return {
		description: total ? `${total} ${total === 1 ? "memory" : "memories"}` : "No memories yet",
	};
}

export function useOverviewVaultsModule({
	projectIds,
	resolution,
	enabled = true,
}: {
	projectIds: readonly string[];
	resolution: "loading" | "unavailable" | "ready";
	enabled?: boolean;
}): AgentOverviewModuleContent {
	const query = useAgentProjectVaults(projectIds, { enabled: enabled && resolution === "ready" });
	if (resolution === "loading" || query.isLoading)
		return { description: <OverviewDescriptionSkeleton label="vaults" /> };
	if (resolution === "unavailable") return { description: "Unavailable right now" };
	if (query.error)
		return {
			description: "Unavailable right now",
			body: <OverviewModuleError label="Vaults" onRetry={() => void query.refetch()} />,
		};
	const vaults = query.data ?? [];
	return {
		description: vaults.length
			? `${vaults.length} ${vaults.length === 1 ? "vault" : "vaults"}`
			: "No vaults available",
		body: vaults.length ? (
			<OverviewResourceDetails items={vaults.map((vault) => vault.name)} />
		) : undefined,
	};
}

export function useOverviewConnectorsModule({
	enabled = true,
}: {
	enabled?: boolean;
} = {}): AgentOverviewModuleContent {
	const connected = useConnectedAppCards(undefined, {
		enabled,
		limit: OVERVIEW_IDENTITY_RAIL_LIMIT,
	});
	const connectedNames = new Set(
		connected.activeConnections.flatMap((connection) =>
			connection.app_name ? [connection.app_name] : [],
		),
	);
	const connectedAppCount = connectedNames.size;
	const apps = connected.data;
	const connectionsUnavailable = Boolean(connected.connectionsError);
	const allUnavailable = connectionsUnavailable && apps.length === 0;
	const loadingSlots = Math.max(
		0,
		Math.min(
			OVERVIEW_IDENTITY_RAIL_LIMIT - apps.length,
			connected.connectionsLoading || connected.metadataLoading ? 3 : 0,
		),
	);
	const description = connected.connectionsLoading ? (
		<OverviewDescriptionSkeleton label="apps" />
	) : connectionsUnavailable ? (
		"Unavailable right now"
	) : connectedAppCount ? (
		`${connectedAppCount} connected`
	) : (
		"No apps connected"
	);
	const hasBody =
		allUnavailable || apps.length > 0 || loadingSlots > 0 || Boolean(connected.metadataError);
	return {
		description,
		body: hasBody ? (
			<div className="space-y-3">
				{allUnavailable ? (
					<OverviewModuleError
						label="Apps"
						onRetry={() => {
							connected.refetch();
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
			</div>
		) : undefined,
	};
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
	apps: readonly { name: string; display_name: string; logo: string }[];
	loadingSlots: number;
}) {
	return (
		<OverviewIdentityIconRail label="Connector apps" testId="overview-connector-rail">
			{apps.map((app) => (
				<OverviewIdentityIconItem key={app.name}>
					<Link
						to="/connectors/$name"
						params={{ name: app.name }}
						aria-label={`Connected app: ${app.display_name}`}
						title={`${app.display_name} (connected)`}
						className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						<ConnectorIcon name={app.display_name} logo={app.logo} size="sm" />
					</Link>
				</OverviewIdentityIconItem>
			))}
			{Array.from({ length: loadingSlots }).map((_, index) => (
				<li key={index}>
					<Skeleton className="size-6 rounded-md" aria-label="Loading app" />
				</li>
			))}
		</OverviewIdentityIconRail>
	);
}
