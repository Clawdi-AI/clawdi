"use client";

import { type DeployPaths, extractApiDetail } from "@clawdi/shared/api";
import { useAuth } from "@clerk/nextjs";
import createClient from "openapi-fetch";
import { useMemo } from "react";

/**
 * Typed cross-origin client for clawdi-monorepo's `/connections` API.
 *
 * Mirror of `deploy-api.ts` but for Composio connectors. Same
 * `openapi-fetch` + Clerk JWT shape. Types come from the same
 * generated dump (`deploy-generated.ts` despite its name contains
 * the full monorepo schema), so `DeployPaths` covers `/connections/*`
 * routes as well.
 *
 * Why proxy: a user's Composio connections live under their
 * `clerk_id` entity in monorepo's Composio account. clawdi-cloud's
 * own `/api/connectors` keys connections under the local `user.id`
 * UUID — different entity, different connections. Sharing requires
 * either migrating tokens (Composio has no rename API → forces
 * full re-OAuth) or proxying. We proxy. See
 * `docs/plans/cloud-clawdi-integration.md` § "Composio cross-origin
 * proxy" for the full rationale.
 *
 * Per-request callback URL: monorepo's `POST /connections/{app}/connect`
 * accepts `body.redirect_url`, validated against an HTTPS-or-localhost
 * scheme allowlist. We pass `cloud.clawdi.ai/connectors/callback` so
 * the user lands back on cloud after OAuth, not monorepo. Composio
 * still stores the token under `clerk_id`, so both products see it.
 */

export type {
	AuthFieldsResponse,
	AvailableAppItem,
	AvailableAppListResponse,
	ConnectionDisconnectResponse,
	ConnectionItem,
	ConnectionListResponse,
	ConnectionVerifyResponse,
	ConnectorCatalogResponse,
	ConnectorToolsResponse,
	ConnectRequest,
	ConnectResponse,
} from "@clawdi/shared/api";

import type { DeployComponents } from "@clawdi/shared/api";

// Catalog item lives on the same generated dump but isn't surfaced
// via the deploy/connections re-export modules — we only need it
// inside the hosted hooks for schema adaptation, so re-export here
// rather than expanding the shared package's public surface.
export type ConnectorCatalogItem = DeployComponents["schemas"]["ConnectorCatalogItem"];

const COMPOSIO_API_URL = process.env.NEXT_PUBLIC_DEPLOY_API_URL || "http://localhost:50021";

export class ComposioApiError extends Error {
	constructor(
		public status: number,
		public detail: string,
	) {
		super(`Composio API ${status}: ${detail}`);
		this.name = "ComposioApiError";
	}
}

/**
 * Hosted-only Composio API client. Calls clawdi-monorepo's
 * `/connections/*` routes cross-origin with the user's Clerk JWT.
 * Same `useMemo` stability as `useDeployApi` so React Query keys
 * don't churn.
 */
export function useComposioApi() {
	const { getToken } = useAuth();
	return useMemo(() => {
		const client = createClient<DeployPaths>({ baseUrl: COMPOSIO_API_URL });
		client.use({
			async onRequest({ request }) {
				const token = await getToken();
				if (token) request.headers.set("Authorization", `Bearer ${token}`);
				return request;
			},
		});
		return client;
	}, [getToken]);
}

/**
 * Unwrap an `openapi-fetch` response into the data, or throw a
 * structured `ComposioApiError` for non-2xx responses. Mirrors
 * `unwrapDeploy` so call sites read the same way.
 */
export function unwrapComposio<T>(result: { data?: T; error?: unknown; response: Response }): T {
	if (result.error !== undefined || result.data === undefined) {
		throw new ComposioApiError(
			result.response.status,
			extractApiDetail(result.error) ?? result.response.statusText,
		);
	}
	return result.data;
}

/**
 * Build the redirect URL we hand to monorepo's `connect` endpoint.
 * Composio sends the user back here after OAuth so they land on the
 * product they clicked from, not on `clawdi.ai/dashboard`.
 *
 * Lands directly on the connector's detail page — no intermediary
 * callback route. The detail page is going to refetch on mount
 * anyway, and the original tab refetches on window focus, so the
 * extra hop served only as a 1.5s spinner. If OAuth fails, Composio
 * appends `?error=…` and the detail page surfaces it via toast.
 *
 * Computed from the live `window.location` instead of an env var so
 * dev deployments (Vercel preview, localhost, conductor worktrees)
 * each route their callbacks back to themselves without needing a
 * per-environment override.
 */
export function composioCallbackUrl(appName: string): string {
	const slug = encodeURIComponent(appName);
	if (typeof window === "undefined") {
		// Server-side render path — should never actually be called
		// since composio mutations are user-initiated, but the guard
		// keeps TS narrowing happy and prevents accidental breakage.
		return `https://cloud.clawdi.ai/connectors/${slug}`;
	}
	return `${window.location.origin}/connectors/${slug}`;
}
