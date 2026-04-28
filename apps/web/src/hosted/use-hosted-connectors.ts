"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
 * Pull the full hosted catalog and project to cloud's
 * `AvailableAppItem`-equivalent shape, with client-side filter +
 * pagination so the page component can stay shape-agnostic.
 *
 * `keepPreviousData` matches the cloud-api version's behavior:
 * page-flips and search-debounces don't flash skeleton.
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
	const api = useComposioApi();
	return useQuery({
		queryKey: [...HOSTED_CATALOG_KEY, { page, pageSize, search }] as const,
		queryFn: async (): Promise<HostedCatalogPage> => {
			const data = await unwrapComposio(await api.GET("/connections/connector-catalog", {}));
			return paginateCatalog(data.items, { page, pageSize, search });
		},
		enabled,
		placeholderData: keepPreviousData,
	});
}

export function useHostedAvailableApp({ appName, enabled }: { appName: string; enabled: boolean }) {
	const api = useComposioApi();
	return useQuery({
		queryKey: [...HOSTED_CATALOG_KEY, "single", appName] as const,
		queryFn: async (): Promise<CloudShapedAvailableApp> => {
			// Single-app lookup isn't a dedicated monorepo endpoint —
			// the catalog is already cached, so we slice it. The catalog
			// fetch happens once across the page session.
			const data = await unwrapComposio(await api.GET("/connections/connector-catalog", {}));
			const item = data.items.find((i: ConnectorCatalogItem) => i.name === appName);
			if (!item) {
				throw new Error(`Connector "${appName}" not found`);
			}
			return toAvailableAppItem(item);
		},
		enabled,
	});
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
					body: { redirect_url: composioCallbackUrl() },
				}),
			);
			// Monorepo returns `{ url }`; cloud's UI expects `{ connect_url, id }`.
			// id is unknown until OAuth completes, so we synthesize a placeholder
			// that the callback page resolves via /verify.
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
