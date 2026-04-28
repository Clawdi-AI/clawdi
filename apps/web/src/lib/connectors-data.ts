"use client";

import {
	keepPreviousData,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { unwrap, useApi } from "@/lib/api";

/**
 * Connector data hooks. Always talk to cloud-api — there is no
 * hosted/cloud branching here. cloud-api uses the user's Clerk id
 * as the Composio entity_id, which means a cloud.clawdi.ai
 * deployment can configure cloud-api with the same Composio API
 * key clawdi.ai's own backend uses and reach the exact same
 * connection namespace; self-hosters get an isolated namespace
 * keyed by their own Clerk app's user ids.
 *
 * The earlier `IS_HOSTED` proxy that pointed connector calls
 * cross-origin at clawdi.ai has been removed; that bypass made the
 * connector backend logic live in two places and forced the
 * frontend to maintain shape adapters. Single source of truth wins.
 */

// ─────────────────────────────────────────────────────────────────────
// Reads

export function useConnections() {
	const api = useApi();
	return useQuery({
		queryKey: ["connections"],
		queryFn: async () => unwrap(await api.GET("/api/connectors")),
	});
}

export function useAvailableApp(appName: string) {
	const api = useApi();
	return useQuery({
		queryKey: ["available-app", appName],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/available/{app_name}", {
					params: { path: { app_name: appName } },
				}),
			),
	});
}

export function useAvailableApps({
	page,
	pageSize,
	search,
}: {
	page: number;
	pageSize: number;
	search?: string;
}) {
	const api = useApi();
	return useQuery({
		queryKey: ["available-apps", { page, pageSize, search }] as const,
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/available", {
					params: {
						query: { page, page_size: pageSize, ...(search ? { search } : {}) },
					},
				}),
			),
		placeholderData: keepPreviousData,
	});
}

export function useConnectorTools(appName: string) {
	const api = useApi();
	return useQuery({
		queryKey: ["connector-tools", appName],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/{app_name}/tools", {
					params: { path: { app_name: appName } },
				}),
			),
	});
}

export function useAuthFields(appName: string, { enabled }: { enabled: boolean }) {
	const api = useApi();
	return useQuery({
		queryKey: ["auth-fields", appName],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/{app_name}/auth-fields", {
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
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({ appName, redirectUrl }: { appName: string; redirectUrl?: string }) =>
			unwrap(
				await api.POST("/api/connectors/{app_name}/connect", {
					params: { path: { app_name: appName } },
					body: redirectUrl ? { redirect_url: redirectUrl } : {},
				}),
			),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
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
				await api.POST("/api/connectors/{app_name}/connect-credentials", {
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
				await api.DELETE("/api/connectors/{connection_id}", {
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
		queries: names.map((name) => ({
			queryKey: ["available-app", name] as const,
			queryFn: async () =>
				unwrap(
					await api.GET("/api/connectors/available/{app_name}", {
						params: { path: { app_name: name } },
					}),
				),
		})),
	});

	const data = useMemo(() => lookup.flatMap((q) => (q.data ? [q.data] : [])), [lookup]);
	const isLoading = connectionsQ.isLoading || lookup.some((q) => q.isLoading);
	const error = connectionsQ.error ?? lookup.find((q) => q.error)?.error ?? null;

	return { activeConnections, data, isLoading, error };
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
