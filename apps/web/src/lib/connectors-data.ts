"use client";

import {
	keepPreviousData,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import {
	type CloudShapedAuthFields,
	type CloudShapedAvailableApp,
	type CloudShapedConnection,
	useHostedAuthFields,
	useHostedAvailableApp,
	useHostedAvailableApps,
	useHostedAvailableAppsByName,
	useHostedConnectCredentialsMutation,
	useHostedConnections,
	useHostedConnectMutation,
	useHostedConnectorTools,
	useHostedDisconnectMutation,
} from "@/hosted/use-hosted-connectors";
import { unwrap, useApi } from "@/lib/api";
import { IS_HOSTED } from "@/lib/hosted";

/**
 * Source-agnostic data hooks for the connectors UI.
 *
 * Each hook composes a cloud-api `useQuery`/`useMutation` and the
 * matching `useHosted…` hook, then picks the active branch via the
 * compile-time `IS_HOSTED` flag. The returned shape is whatever the
 * cloud-api side already produces — hosted hooks adapt clawdi.ai's
 * payload to that shape, so consumers can stay branch-free.
 *
 * Both branches always-call their hooks (`enabled` gates the network)
 * to keep React's rules-of-hooks happy across IS_HOSTED settings.
 *
 * Naming: `useConnections`, `useAvailableApps`, etc. — no hosted/cloud
 * prefix on the public name. The branching is internal.
 */

const PICK = <T>(hosted: T, cloud: T): T => (IS_HOSTED ? hosted : cloud);

// ─────────────────────────────────────────────────────────────────────
// Reads

export function useConnections() {
	const api = useApi();
	const cloud = useQuery({
		queryKey: ["connections"],
		queryFn: async () => unwrap(await api.GET("/api/connectors")),
		enabled: !IS_HOSTED,
	});
	const hosted = useHostedConnections({ enabled: IS_HOSTED });
	return PICK(hosted, cloud);
}

export function useAvailableApp(appName: string) {
	const api = useApi();
	const cloud = useQuery({
		queryKey: ["available-app", appName],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/available/{app_name}", {
					params: { path: { app_name: appName } },
				}),
			),
		enabled: !IS_HOSTED,
	});
	const hosted = useHostedAvailableApp({ appName, enabled: IS_HOSTED });
	return PICK(hosted, cloud);
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
	const cloud = useQuery({
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
		enabled: !IS_HOSTED,
	});
	const hosted = useHostedAvailableApps({ enabled: IS_HOSTED, page, pageSize, search });
	return PICK(hosted, cloud);
}

export function useConnectorTools(appName: string) {
	const api = useApi();
	const cloud = useQuery({
		queryKey: ["connector-tools", appName],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/{app_name}/tools", {
					params: { path: { app_name: appName } },
				}),
			),
		enabled: !IS_HOSTED,
	});
	const hosted = useHostedConnectorTools({ appName, enabled: IS_HOSTED });
	return PICK(hosted, cloud);
}

export function useAuthFields(appName: string, { enabled }: { enabled: boolean }) {
	const api = useApi();
	const cloud = useQuery({
		queryKey: ["auth-fields", appName],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/{app_name}/auth-fields", {
					params: { path: { app_name: appName } },
				}),
			),
		enabled: enabled && !IS_HOSTED,
	});
	const hosted = useHostedAuthFields({ appName, enabled: enabled && IS_HOSTED });
	// Asymmetric pick (per field, not the whole result) because the two
	// branches have slightly different `UseQueryResult` shapes — the
	// cloud-api query returns the cloud-api response type directly while
	// the hosted hook returns the projected `CloudShapedAuthFields`.
	// Picking field-by-field keeps the unified surface tight without
	// forcing both branches into the same parameterized result type.
	const data: CloudShapedAuthFields | undefined = PICK(hosted.data, cloud.data);
	return {
		data,
		isLoading: PICK(hosted.isLoading, cloud.isLoading),
		error: PICK(hosted.error, cloud.error),
	};
}

// ─────────────────────────────────────────────────────────────────────
// Mutations

export function useConnect() {
	const api = useApi();
	const qc = useQueryClient();
	const cloud = useMutation({
		mutationFn: async ({ appName }: { appName: string }) =>
			unwrap(
				await api.POST("/api/connectors/{app_name}/connect", {
					params: { path: { app_name: appName } },
					body: {},
				}),
			),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
	});
	const hosted = useHostedConnectMutation();
	return PICK(hosted, cloud);
}

export function useConnectCredentials() {
	const api = useApi();
	const qc = useQueryClient();
	const cloud = useMutation({
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
	const hosted = useHostedConnectCredentialsMutation();
	return PICK(hosted, cloud);
}

export function useDisconnect() {
	const api = useApi();
	const qc = useQueryClient();
	const cloud = useMutation({
		mutationFn: async ({ connectionId }: { connectionId: string }): Promise<void> => {
			// Cloud-api returns `{ status: "disconnected" }`; hosted returns
			// nothing. Drop the body so both branches type-check the same.
			unwrap(
				await api.DELETE("/api/connectors/{connection_id}", {
					params: { path: { connection_id: connectionId } },
				}),
			);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
	});
	const hosted = useHostedDisconnectMutation();
	return PICK(hosted, cloud);
}

// ─────────────────────────────────────────────────────────────────────
// Composite hooks
//
// Connections carry the user's identity (slug + status + account
// label) but not the catalog metadata UI cards need (display name,
// logo, description). `useConnectedAppCards` joins the two so the
// list page can render a "Connected" rail that's always visible —
// independent of which catalog page the user is on. This matters
// because catalog ordering (clawdi.ai's `base_rank`) can place a
// user's active app on page 30 of 1000 connectors, where the user
// would never find it without searching.
//
// HOSTED: shares the single full-catalog query already cached, so
// enrichment is in-memory, no extra network.
// OSS: fans out to per-app `/available/{name}` queries — the active
// connection count is small (typically <10) so this is cheap enough.

export function useConnectedAppCards() {
	const connectionsQ = useConnections();

	const activeConnections = useMemo(
		() => connectionsQ.data?.filter(isActiveConnection) ?? [],
		[connectionsQ.data],
	);
	// Dedupe so multi-account-same-app users don't pay for two catalog
	// lookups (OSS) or render duplicate cards with colliding React
	// keys. The Connected rail is per-app, not per-connection — the
	// detail page is where the user picks between accounts.
	const names = useMemo(
		() => Array.from(new Set(activeConnections.map((c) => c.app_name))),
		[activeConnections],
	);

	// HOSTED: single shared query, lookup in-memory.
	const hostedLookup = useHostedAvailableAppsByName({
		names,
		enabled: IS_HOSTED && names.length > 0,
	});

	// OSS: per-app queries via `useQueries`. Always-call (rules of
	// hooks): empty `names` short-circuits to an empty fan-out.
	const api = useApi();
	const ossLookup = useQueries({
		queries: IS_HOSTED
			? []
			: names.map((name) => ({
					queryKey: ["available-app", name] as const,
					queryFn: async () =>
						unwrap(
							await api.GET("/api/connectors/available/{app_name}", {
								params: { path: { app_name: name } },
							}),
						),
					enabled: !IS_HOSTED,
				})),
	});

	const ossData = useMemo(() => ossLookup.flatMap((q) => (q.data ? [q.data] : [])), [ossLookup]);
	const ossLoading = ossLookup.some((q) => q.isLoading);
	const ossError = ossLookup.find((q) => q.error)?.error ?? null;

	const data = PICK(hostedLookup.data, ossData);
	return {
		activeConnections,
		data: data ?? [],
		isLoading: connectionsQ.isLoading || PICK(hostedLookup.isLoading, ossLoading),
		error: connectionsQ.error ?? PICK(hostedLookup.error, ossError),
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

// ─────────────────────────────────────────────────────────────────────
// Re-export the unified shapes the page UI consumes.

export type { CloudShapedAuthFields, CloudShapedAvailableApp, CloudShapedConnection };
