"use client";

import type { components } from "@clawdi/shared/api";
import {
	keepPreviousData,
	queryOptions,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { type OpenApiClient, unwrap, useApi, useOpenApi } from "@/lib/api";

/**
 * Connector data hooks. Always talk to cloud-api — there is no
 * hosted/cloud branching here. cloud-api uses the user's Clerk id
 * as the Composio entity_id, so hosted deployments and self-hosted
 * installs both use the same cloud-api connector contract while each
 * Clerk app keeps its own user namespace.
 *
 * The earlier `IS_HOSTED` proxy that pointed connector calls
 * cross-origin has been removed; that bypass made the connector
 * backend logic live in two places and forced the frontend to maintain
 * shape adapters. Single source of truth wins.
 */

// ─────────────────────────────────────────────────────────────────────
// Reads

export const CONNECTOR_CATALOG_PAGE_SIZE = 24;
export const CONNECTOR_CATALOG_STALE_TIME_MS = 10 * 60 * 1000;
export const CONNECTOR_CATALOG_GC_TIME_MS = CONNECTOR_CATALOG_STALE_TIME_MS;

export type ConnectorAvailableApp = components["schemas"]["ConnectorAvailableAppResponse"];
export type ConnectorMetadata = components["schemas"]["ConnectorMetadataResponse"];

export function connectorMetadataBatches(names: readonly string[]): string[][] {
	const unique = [...new Set(names.filter(Boolean))];
	const batches: string[][] = [];
	for (let offset = 0; offset < unique.length; offset += 100) {
		batches.push(unique.slice(offset, offset + 100));
	}
	return batches;
}

function connectorMetadataQueryOptions(api: ReturnType<typeof useApi>, names: string[]) {
	return queryOptions({
		queryKey: ["connector-metadata", names],
		queryFn: async ({ signal }) =>
			unwrap(await api.POST("/v1/connectors/metadata:batchRead", { body: { names }, signal })),
		staleTime: CONNECTOR_CATALOG_STALE_TIME_MS,
		gcTime: CONNECTOR_CATALOG_GC_TIME_MS,
	});
}

export type AvailableAppsQueryArgs = {
	page: number;
	pageSize: number;
	search?: string;
};

export function availableAppsQueryKey({ page, pageSize, search }: AvailableAppsQueryArgs) {
	return [
		"get",
		"/v1/connectors/available",
		{ params: { query: { page, page_size: pageSize, ...(search ? { search } : {}) } } },
	] as const;
}

export function availableAppsQueryOptions(api: OpenApiClient, args: AvailableAppsQueryArgs) {
	const { page, pageSize, search } = args;
	return api.queryOptions(
		"get",
		"/v1/connectors/available",
		{
			params: { query: { page, page_size: pageSize, ...(search ? { search } : {}) } },
		},
		{
			staleTime: CONNECTOR_CATALOG_STALE_TIME_MS,
			gcTime: CONNECTOR_CATALOG_GC_TIME_MS,
		},
	);
}

export function availableAppQueryKey(appName: string) {
	return [
		"get",
		"/v1/connectors/available/{app_name}",
		{ params: { path: { app_name: appName } } },
	] as const;
}

export function availableAppQueryOptions(api: OpenApiClient, appName: string) {
	return api.queryOptions(
		"get",
		"/v1/connectors/available/{app_name}",
		{
			params: { path: { app_name: appName } },
		},
		{
			staleTime: CONNECTOR_CATALOG_STALE_TIME_MS,
			gcTime: CONNECTOR_CATALOG_GC_TIME_MS,
		},
	);
}

export function connectionsQueryOptions(api: OpenApiClient) {
	return api.queryOptions(
		"get",
		"/v1/connectors",
		{},
		{
			refetchOnWindowFocus: "always" as const,
		},
	);
}

export function connectorToolsQueryKey(appName: string) {
	return [
		"get",
		"/v1/connectors/{app_name}/tools",
		{ params: { path: { app_name: appName } } },
	] as const;
}

export function connectorToolsQueryOptions(api: OpenApiClient, appName: string) {
	return api.queryOptions(
		"get",
		"/v1/connectors/{app_name}/tools",
		{
			params: { path: { app_name: appName } },
		},
		{
			staleTime: CONNECTOR_CATALOG_STALE_TIME_MS,
			gcTime: CONNECTOR_CATALOG_GC_TIME_MS,
		},
	);
}

export function useConnections({ enabled = true }: { enabled?: boolean } = {}) {
	const api = useOpenApi();
	return useQuery({ ...connectionsQueryOptions(api), enabled });
}

export function useAvailableApp(appName: string) {
	const api = useOpenApi();
	return useQuery(availableAppQueryOptions(api, appName));
}

export function useAvailableApps({
	page,
	pageSize,
	search,
	enabled = true,
}: AvailableAppsQueryArgs & { enabled?: boolean }) {
	const api = useOpenApi();
	return useQuery({
		...availableAppsQueryOptions(api, { page, pageSize, search }),
		placeholderData: keepPreviousData,
		enabled,
	});
}

export function useConnectorTools(appName: string) {
	const api = useOpenApi();
	return useQuery(connectorToolsQueryOptions(api, appName));
}

export function useAuthFields(appName: string, { enabled }: { enabled: boolean }) {
	return useOpenApi().useQuery(
		"get",
		"/v1/connectors/{app_name}/auth-fields",
		{ params: { path: { app_name: appName } } },
		{ enabled },
	);
}

// ─────────────────────────────────────────────────────────────────────
// Mutations

export function useDisconnect() {
	const api = useOpenApi();
	const qc = useQueryClient();
	return api.useMutation("delete", "/v1/connectors/{connection_id}", {
		onSuccess: () => qc.invalidateQueries({ queryKey: ["get", "/v1/connectors"] }),
	});
}

// ─────────────────────────────────────────────────────────────────────
// Composite hooks

/**
 * Joins the user's ACTIVE connections with catalog metadata so the
 * list page can render a "Connected" rail that's always visible,
 * independent of which catalog page the user is on. Backend
 * orders the catalog by Composio's popularity (`base_rank`) which
 * can put a user's active app on page 30 of 1000 connectors —
 * without this rail, they'd never find their connections without
 * searching.
 *
 * Display metadata is fetched in bounded batches, independently of the
 * current catalog page. It never seeds the authoritative detail query.
 */
export function useConnectedAppCards({ enabled = true }: { enabled?: boolean } = {}) {
	const connectionsQ = useConnections({ enabled });
	const api = useApi();

	const activeConnections = useMemo(
		() => connectionsQ.data?.filter(isActiveConnection) ?? [],
		[connectionsQ.data],
	);
	// Dedupe so multi-account-same-app users don't pay for two catalog
	// lookups or render duplicate cards with colliding React keys. The
	// rail is per-app, not per-connection — the detail page is where
	// the user picks between accounts. Filter out connections with a
	// missing/empty `app_name` defensively — Composio always returns
	// it in practice, but a malformed row would otherwise become an
	// invalid metadata name in a batch request.
	const names = useMemo(
		() => Array.from(new Set(activeConnections.flatMap((c) => (c.app_name ? [c.app_name] : [])))),
		[activeConnections],
	);
	const batches = useMemo(() => connectorMetadataBatches(names), [names]);

	const lookup = useQueries({
		queries: batches.map((batch) => ({
			...connectorMetadataQueryOptions(api, batch),
			enabled,
		})),
	});

	const data = useMemo(() => {
		const byName = new Map<string, ConnectorMetadata>();
		for (const query of lookup) {
			for (const app of query.data?.items ?? []) byName.set(app.name, app);
			for (const name of query.data?.missing ?? []) {
				byName.set(name, { name, display_name: name, logo: "", description: "" });
			}
		}
		return names.flatMap((name) => {
			const app = byName.get(name);
			return app ? [app] : [];
		});
	}, [lookup, names]);
	const isLoading = connectionsQ.isLoading || lookup.some((q) => q.isLoading);
	const connectionsLoading = connectionsQ.isLoading;
	const metadataLoading = lookup.some((q) => q.isLoading);
	const connectionsError = connectionsQ.error;
	const metadataError = lookup.find((q) => q.error)?.error ?? null;
	const error = connectionsError ?? metadataError;
	const hasData =
		connectionsQ.data !== undefined && lookup.every((query) => query.data !== undefined);
	const refetch = () => {
		void connectionsQ.refetch();
		for (const q of lookup) void q.refetch();
	};

	return {
		activeConnections,
		data,
		hasData,
		isLoading,
		connectionsLoading,
		metadataLoading,
		error,
		connectionsError,
		metadataError,
		refetch,
	};
}

// ─────────────────────────────────────────────────────────────────────
// Status helpers
//
// Composio's connection lifecycle has many states (INITIALIZING →
// INITIATED → ACTIVE → … → EXPIRED / FAILED / INACTIVE). Only ACTIVE
// connections are usable: an INITIALIZING row exists before OAuth
// completes (and may stick around forever if the user abandons), an
// EXPIRED row needs reconnection, and FAILED / INACTIVE are dead.
// Surfacing any of these as "Connected" misleads the user — list
// pages show a Connected checkmark for an app that doesn't work, and
// detail pages show a Disconnect button on a row that isn't real yet.
// Filter user-facing lists with `isActiveConnection`. Re-connecting
// from the UI lets Composio update or replace the old row, so we
// don't lose the user's ability to recover from EXPIRED/FAILED.

export function isActiveConnection(c: { status: string }): boolean {
	return c.status.toUpperCase() === "ACTIVE";
}
