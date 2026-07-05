"use client";

import type { components } from "@clawdi/shared/api";
import {
	keepPreviousData,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { unwrap, useApi } from "@/lib/api";

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

type ApiClient = ReturnType<typeof useApi>;
type ConnectorAvailableApp = components["schemas"]["ConnectorAvailableAppResponse"];

export type AvailableAppsQueryArgs = {
	page: number;
	pageSize: number;
	search?: string;
};

export function availableAppsQueryKey({ page, pageSize, search }: AvailableAppsQueryArgs) {
	return ["available-apps", { page, pageSize, search }] as const;
}

export function availableAppsQueryOptions(api: ApiClient, args: AvailableAppsQueryArgs) {
	const { page, pageSize, search } = args;
	return {
		queryKey: availableAppsQueryKey(args),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/connectors/available", {
					params: {
						query: { page, page_size: pageSize, ...(search ? { search } : {}) },
					},
				}),
			),
		staleTime: CONNECTOR_CATALOG_STALE_TIME_MS,
		gcTime: CONNECTOR_CATALOG_GC_TIME_MS,
	};
}

export function availableAppQueryKey(appName: string) {
	return ["available-app", appName] as const;
}

export function availableAppQueryOptions(api: ApiClient, appName: string) {
	return {
		queryKey: availableAppQueryKey(appName),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/connectors/available/{app_name}", {
					params: { path: { app_name: appName } },
				}),
			),
		staleTime: CONNECTOR_CATALOG_STALE_TIME_MS,
		gcTime: CONNECTOR_CATALOG_GC_TIME_MS,
	};
}

export function connectionsQueryOptions(api: ApiClient) {
	return {
		queryKey: ["connections"] as const,
		queryFn: async () => unwrap(await api.GET("/v1/connectors")),
		refetchOnWindowFocus: "always" as const,
	};
}

export function connectorToolsQueryKey(appName: string) {
	return ["connector-tools", appName] as const;
}

export function connectorToolsQueryOptions(api: ApiClient, appName: string) {
	return {
		queryKey: connectorToolsQueryKey(appName),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/connectors/{app_name}/tools", {
					params: { path: { app_name: appName } },
				}),
			),
		staleTime: CONNECTOR_CATALOG_STALE_TIME_MS,
		gcTime: CONNECTOR_CATALOG_GC_TIME_MS,
	};
}

export function useConnections() {
	const api = useApi();
	return useQuery(connectionsQueryOptions(api));
}

export function useAvailableApp(appName: string) {
	const api = useApi();
	return useQuery(availableAppQueryOptions(api, appName));
}

export function useAvailableApps({ page, pageSize, search }: AvailableAppsQueryArgs) {
	const api = useApi();
	const queryClient = useQueryClient();
	const query = useQuery({
		...availableAppsQueryOptions(api, { page, pageSize, search }),
		placeholderData: keepPreviousData,
	});
	useEffect(() => {
		const apps = query.data?.items;
		if (!apps) return;
		for (const app of apps) {
			queryClient.setQueryData<ConnectorAvailableApp>(availableAppQueryKey(app.name), app);
		}
	}, [query.data?.items, queryClient]);
	return query;
}

export function useConnectorTools(appName: string) {
	const api = useApi();
	return useQuery(connectorToolsQueryOptions(api, appName));
}

export function useAuthFields(appName: string, { enabled }: { enabled: boolean }) {
	const api = useApi();
	return useQuery({
		queryKey: ["auth-fields", appName],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/connectors/{app_name}/auth-fields", {
					params: { path: { app_name: appName } },
				}),
			),
		enabled,
	});
}

// ─────────────────────────────────────────────────────────────────────
// Mutations

export function useConnect() {
	const api = useApi();
	return useMutation({
		mutationFn: async ({ appName, redirectUrl }: { appName: string; redirectUrl?: string }) =>
			unwrap(
				await api.POST("/v1/connectors/{app_name}/connect", {
					params: { path: { app_name: appName } },
					body: redirectUrl ? { redirect_url: redirectUrl } : {},
				}),
			),
	});
}

export function useConnectCredentials() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({
			appName,
			credentials,
		}: {
			appName: string;
			credentials: Record<string, string>;
		}) =>
			unwrap(
				await api.POST("/v1/connectors/{app_name}/connect-credentials", {
					params: { path: { app_name: appName } },
					body: { credentials },
				}),
			),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
	});
}

export function useDisconnect() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({ connectionId }: { connectionId: string }): Promise<void> => {
			unwrap(
				await api.DELETE("/v1/connectors/{connection_id}", {
					params: { path: { connection_id: connectionId } },
				}),
			);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
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
 * Fan-out: one `/available/{name}` query per unique active app.
 * Active connection count is small in practice (single-digit per
 * user), and React Query dedupes against the catalog cache so a
 * page that already loaded the connector also has its metadata.
 */
export function useConnectedAppCards() {
	const connectionsQ = useConnections();
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
	// `undefined` Set entry and fan out a useQueries with a broken
	// path param.
	const names = useMemo(
		() => Array.from(new Set(activeConnections.flatMap((c) => (c.app_name ? [c.app_name] : [])))),
		[activeConnections],
	);

	const lookup = useQueries({
		queries: names.map((name) => availableAppQueryOptions(api, name)),
	});

	const data = useMemo(() => lookup.flatMap((q) => (q.data ? [q.data] : [])), [lookup]);
	const isLoading = connectionsQ.isLoading || lookup.some((q) => q.isLoading);
	const error = connectionsQ.error ?? lookup.find((q) => q.error)?.error ?? null;
	const refetch = () => {
		void connectionsQ.refetch();
		for (const q of lookup) void q.refetch();
	};

	return { activeConnections, data, isLoading, error, refetch };
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
