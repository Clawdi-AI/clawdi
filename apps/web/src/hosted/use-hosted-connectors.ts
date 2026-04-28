"use client";

import type { ConnectionItem, ConnectorCatalogItem } from "@clawdi/shared/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { unwrapClawdi, useClawdiApi } from "@/hosted/clawdi-api";

/**
 * Adapter hooks that project clawdi.ai's `/connections/*` shapes
 * onto the surface cloud's connectors UI expects, so the OSS components
 * stay unchanged. The full catalog is fetched once via
 * `/connector-catalog` and sliced client-side — ~1k items is fine over
 * one wire, and skipping per-page-flip refetches matches the
 * cloud-api version's in-memory cache + slicing perceived snappiness.
 */

const HOSTED_CATALOG_KEY = ["hosted", "connector-catalog"] as const;
const HOSTED_CONNECTIONS_KEY = ["hosted", "connections"] as const;

/**
 * Cloud-shaped catalog item (matches `ConnectorAvailableAppResponse`:
 * `name`, `display_name`, `logo`, `description`, `auth_type`). Both
 * source paths converge to this shape so the UI doesn't branch.
 */
export interface CloudShapedAvailableApp {
	name: string;
	display_name: string;
	logo: string;
	description: string;
	auth_type: string;
}

/** Single field the API-key credentials dialog needs to render. */
export interface CloudShapedAuthField {
	name: string;
	display_name: string;
	description: string;
	type: string;
	required: boolean;
	is_secret: boolean;
	expected_from_customer: boolean;
	default?: string | null;
}

export interface CloudShapedAuthFields {
	auth_scheme: string;
	expected_input_fields: CloudShapedAuthField[];
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
	const api = useClawdiApi();
	return useQuery({
		queryKey: HOSTED_CONNECTIONS_KEY,
		queryFn: async () => {
			const data = await unwrapClawdi(await api.GET("/connections", {}));
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
	const api = useClawdiApi();
	return useQuery({
		queryKey: HOSTED_CATALOG_KEY,
		queryFn: async (): Promise<ConnectorCatalogItem[]> => {
			const data = await unwrapClawdi(await api.GET("/connections/connector-catalog", {}));
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
	const api = useClawdiApi();
	return useQuery({
		queryKey: ["hosted", "connector-tools", appName] as const,
		queryFn: async () => {
			const data = await unwrapClawdi(
				await api.GET("/connections/connector-catalog/{app_name}/tools", {
					params: { path: { app_name: appName } },
				}),
			);
			// clawdi.ai's tools response wraps tools under `.tools`; cloud's UI
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

export function useHostedAuthFields({ appName, enabled }: { appName: string; enabled: boolean }) {
	const api = useClawdiApi();
	return useQuery({
		queryKey: ["hosted", "auth-fields", appName] as const,
		queryFn: async (): Promise<CloudShapedAuthFields> => {
			const data = await unwrapClawdi(
				await api.GET("/connections/{app_name}/auth-fields", {
					params: { path: { app_name: appName } },
				}),
			);
			return {
				auth_scheme: data.auth_scheme,
				expected_input_fields: data.expected_input_fields.map(toCloudAuthField),
			};
		},
		enabled,
	});
}

export function useHostedConnectCredentialsMutation() {
	const api = useClawdiApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({
			appName,
			credentials,
		}: {
			appName: string;
			credentials: Record<string, string>;
		}) => {
			return unwrapClawdi(
				await api.POST("/connections/{app_name}/connect-credentials", {
					params: { path: { app_name: appName } },
					body: { credentials },
				}),
			);
		},
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: HOSTED_CONNECTIONS_KEY });
		},
	});
}

export function useHostedConnectMutation() {
	const api = useClawdiApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({ appName }: { appName: string }) => {
			const data = await unwrapClawdi(
				await api.POST("/connections/{app_name}/connect", {
					params: { path: { app_name: appName } },
					body: { redirect_url: composioCallbackUrl(appName) },
				}),
			);
			// clawdi.ai returns `{ url }`; cloud's UI expects `{ connect_url, id }`.
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
	const api = useClawdiApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({ connectionId }: { connectionId: string }) => {
			await unwrapClawdi(
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

// Heuristic for "should this input render as a password?" — clawdi.ai's
// `AuthFieldItem` doesn't carry a dedicated `is_secret` flag, so we
// match against the field's tokens (split on snake/kebab/camel
// boundaries) instead of a substring check on the joined string. That
// way `apiKey` / `access_token` / `webhook-secret` all hit, but
// `bookkeeper` (which contains the substring "key") doesn't.
// Cloud-api's response DOES carry the flag so the OSS path uses it
// directly without this fallback.
const SECRET_TOKENS = new Set(["key", "token", "secret", "password", "bearer"]);

function isLikelySecret(field: { name: string; type: string }): boolean {
	if (field.type === "password") return true;
	// Split snake/kebab on the separators and camelCase on case
	// boundaries; lowercase the result and match each token whole.
	const tokens = field.name
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.split(/[\s_-]+/)
		.map((t) => t.toLowerCase());
	return tokens.some((t) => SECRET_TOKENS.has(t));
}

function toCloudAuthField(f: {
	name: string;
	display_name: string;
	description: string;
	type: string;
	required: boolean;
	expected_from_customer?: boolean | null;
}): CloudShapedAuthField {
	return {
		name: f.name,
		display_name: f.display_name,
		description: f.description,
		type: f.type,
		required: f.required,
		is_secret: isLikelySecret(f),
		expected_from_customer: f.expected_from_customer ?? true,
	};
}

function toAvailableAppItem(c: ConnectorCatalogItem): CloudShapedAvailableApp {
	// Cloud's UI reads `logo` / `description` / `auth_type`; clawdi.ai's
	// `ConnectorCatalogItem` has `logo_url` and `auth_type`. The catalog
	// endpoint carries description and auth_type natively, so we project
	// from there into cloud's shape.
	return {
		name: c.name,
		display_name: c.display_name,
		logo: c.logo_url,
		description: c.description,
		auth_type: (c.auth_type ?? "oauth2").toLowerCase(),
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

/**
 * Redirect URL handed to clawdi.ai's `connect` endpoint. Lands directly
 * on the connector's detail page — no intermediary callback route.
 * The detail page refetches on mount; the original tab refetches on
 * window focus. Errors come back as `?error=…` and the detail page
 * surfaces them as a toast.
 *
 * Built via the `URL` constructor so the slug gets percent-encoded
 * correctly without manual `encodeURIComponent` interpolation.
 */
function composioCallbackUrl(appName: string): string {
	const origin = typeof window === "undefined" ? "https://cloud.clawdi.ai" : window.location.origin;
	return new URL(`/connectors/${appName}`, origin).toString();
}
