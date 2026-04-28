"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	type ConnectionItem,
	type ConnectorCatalogItem,
	composioCallbackUrl,
	unwrapComposio,
	useComposioApi,
} from "@/hosted/composio-api";

/**
 * React Query hooks that adapt clawdi-monorepo's `/connections/*`
 * shapes to the surface clawdi-cloud's connectors page expects, so
 * the OSS UI components stay unchanged. Each hook mirrors the
 * `useQuery`/`useMutation` ergonomics of the cloud-api equivalents.
 *
 * Hosted catalog has no server pagination. We pull the full catalog
 * once via `/connector-catalog` (richer than `/available-apps` —
 * includes descriptions) and slice client-side; Composio's catalog
 * is ~1k items which is fine to ship in one payload, and avoiding
 * server round-trips per page-flip matches the perceived snappiness
 * of the cloud-api version's in-memory cache + slicing.
 */

const HOSTED_CATALOG_KEY = ["hosted", "connector-catalog"] as const;
const HOSTED_CONNECTIONS_KEY = ["hosted", "connections"] as const;

/**
 * Cloud-shaped catalog item (matches `ConnectorAvailableAppResponse`
 * from the cloud-api side: `name`, `display_name`, `logo`,
 * `description`). Both source paths converge to this shape so the UI
 * doesn't branch on source.
 */
export interface CloudShapedAvailableApp {
	name: string;
	display_name: string;
	logo: string;
	description: string;
}

export interface HostedCatalogPage {
	items: CloudShapedAvailableApp[];
	total: number;
	page: number;
	page_size: number;
}

/**
 * Cloud-shaped connection (matches `ConnectorConnectionResponse`).
 */
export interface CloudShapedConnection {
	id: string;
	app_name: string;
	status: string;
	created_at: string;
}

export function useHostedConnections({ enabled }: { enabled: boolean }) {
	const api = useComposioApi();
	return useQuery({
		queryKey: HOSTED_CONNECTIONS_KEY,
		queryFn: async () => {
			const data = await unwrapComposio(await api.GET("/connections", {}));
			return data.items.map(toCloudConnection);
		},
		enabled,
	});
}

/**
 * Single fetch of the full catalog, shared by all callers via the
 * stable `HOSTED_CATALOG_KEY`. Pagination and single-app lookup are
 * memoized client-side off this one cache entry — no per-page-flip
 * round trip, no per-search debounce refetch.
 */
function useHostedCatalogQuery({ enabled }: { enabled: boolean }) {
	const api = useComposioApi();
	return useQuery({
		queryKey: HOSTED_CATALOG_KEY,
		queryFn: async (): Promise<ConnectorCatalogItem[]> => {
			const data = await unwrapComposio(await api.GET("/connections/connector-catalog", {}));
			return data.items;
		},
		enabled,
	});
}

/**
 * Page slice over the cached catalog. Filter + pagination happen
 * inside `useMemo` so neither changing page nor typing into search
 * triggers a network request — the underlying query is keyed only
 * on `HOSTED_CATALOG_KEY`.
 */
export function useHostedAvailableApps({
	enabled,
	page,
	pageSize,
	search,
}: {
	enabled: boolean;
	page: number;
	pageSize: number;
	search?: string;
}) {
	const q = useHostedCatalogQuery({ enabled });
	const data = useMemo(
		() => (q.data ? paginateCatalog(q.data, { page, pageSize, search }) : undefined),
		[q.data, page, pageSize, search],
	);
	return {
		data,
		isLoading: q.isLoading,
		isFetching: q.isFetching,
		error: q.error,
	};
}

export function useHostedAvailableApp({ appName, enabled }: { appName: string; enabled: boolean }) {
	const q = useHostedCatalogQuery({ enabled });
	const data = useMemo(() => {
		if (!q.data) return undefined;
		const item = q.data.find((i) => i.name === appName);
		return item ? toAvailableAppItem(item) : undefined;
	}, [q.data, appName]);
	// 404 condition: catalog loaded but the requested slug isn't in it.
	// Surface as an error so the consumer's error path renders, instead
	// of leaving the page in an indeterminate "still loading" state.
	const notFound = q.data !== undefined && data === undefined;
	return {
		data,
		isLoading: q.isLoading,
		error: notFound ? new Error(`Connector "${appName}" not found`) : q.error,
	};
}

export function useHostedConnectorTools({
	appName,
	enabled,
}: {
	appName: string;
	enabled: boolean;
}) {
	const api = useComposioApi();
	return useQuery({
		queryKey: ["hosted", "connector-tools", appName] as const,
		queryFn: async () => {
			const data = await unwrapComposio(
				await api.GET("/connections/connector-catalog/{app_name}/tools", {
					params: { path: { app_name: appName } },
				}),
			);
			// Monorepo's tools response wraps tools under `.tools`; cloud's UI
			// reads a flat array. Project to cloud's `ConnectorToolResponse` shape
			// (slug → name) so the existing detail page renders without branching.
			return data.tools.map((t) => ({
				name: t.slug,
				display_name: t.display_name,
				description: t.description,
				is_deprecated: t.is_deprecated,
			}));
		},
		enabled,
	});
}

export function useHostedConnectMutation() {
	const api = useComposioApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({ appName }: { appName: string }) => {
			const data = await unwrapComposio(
				await api.POST("/connections/{app_name}/connect", {
					params: { path: { app_name: appName } },
					body: { redirect_url: composioCallbackUrl(appName) },
				}),
			);
			// Monorepo returns `{ url }`; cloud's UI expects `{ connect_url, id }`.
			// id is unknown until OAuth completes — the user lands on the
			// detail page directly, which refetches the connection list and
			// renders the new entry on its own.
			return { connect_url: data.url, id: "" };
		},
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: HOSTED_CONNECTIONS_KEY });
		},
	});
}

export function useHostedDisconnectMutation() {
	const api = useComposioApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({ connectionId }: { connectionId: string }) => {
			await unwrapComposio(
				await api.DELETE("/connections/{connection_id}", {
					params: { path: { connection_id: connectionId } },
				}),
			);
		},
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: HOSTED_CONNECTIONS_KEY });
		},
	});
}

// ──────────────────────────────────────────────────────────────────
// Schema adapters — keep these in one place so future field renames
// surface as a single typecheck error instead of grepping the UI.

function toCloudConnection(c: ConnectionItem): CloudShapedConnection {
	return {
		id: c.id,
		app_name: c.app_name,
		status: c.status,
		created_at: c.created_at,
	};
}

function toAvailableAppItem(c: ConnectorCatalogItem): CloudShapedAvailableApp {
	// Cloud's UI reads `logo` / `description`; monorepo's `AvailableAppItem`
	// has `logo_url` and no description. The richer catalog endpoint
	// (`/connections/connector-catalog`) carries description, so we
	// project from there into cloud's shape.
	return {
		name: c.name,
		display_name: c.display_name,
		logo: c.logo_url,
		description: c.description,
	};
}

function paginateCatalog(
	items: ConnectorCatalogItem[],
	{ page, pageSize, search }: { page: number; pageSize: number; search?: string },
): HostedCatalogPage {
	const filtered = search ? items.filter((i) => matchesSearch(i, search.toLowerCase())) : items;
	const total = filtered.length;
	const start = (page - 1) * pageSize;
	const slice = filtered.slice(start, start + pageSize).map(toAvailableAppItem);
	return { items: slice, total, page, page_size: pageSize };
}

function matchesSearch(item: ConnectorCatalogItem, q: string): boolean {
	return (
		item.name.toLowerCase().includes(q) ||
		item.display_name.toLowerCase().includes(q) ||
		item.description.toLowerCase().includes(q)
	);
}
