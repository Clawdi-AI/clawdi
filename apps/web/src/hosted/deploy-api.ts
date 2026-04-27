"use client";

import { type Deployment, type DeployPaths, extractApiDetail } from "@clawdi/shared/api";
import { useAuth } from "@clerk/nextjs";
import createClient from "openapi-fetch";
import { useMemo } from "react";

/**
 * Typed cross-origin client for clawdi-monorepo's deploy backend.
 *
 * Same `openapi-fetch` + Clerk shape as cloud's own `lib/api.ts`.
 * Types are generated from the live monorepo `/openapi.json`:
 *
 *     bun --cwd apps/web run generate-deploy-api
 *
 * (with monorepo backend running on :50021). Regenerate whenever
 * the deploy schema changes.
 *
 * Path quirk worth knowing: monorepo's deployments router has NO
 * `/api` prefix — routes mount at `/deployments`, not `/api/deployments`.
 * Different from cloud-api which prefixes everything with `/api`.
 */

export type { Deployment } from "@clawdi/shared/api";

const DEPLOY_API_URL = process.env.NEXT_PUBLIC_DEPLOY_API_URL || "http://localhost:50021";

export class DeployApiError extends Error {
	constructor(
		public status: number,
		public detail: string,
	) {
		super(`Deploy API ${status}: ${detail}`);
		this.name = "DeployApiError";
	}
}

/**
 * Hosted-only deploy API client. The single-replica `useMemo` keeps
 * the request factory stable across renders so React Query keys
 * don't churn.
 */
export function useDeployApi() {
	const { getToken } = useAuth();
	return useMemo(() => {
		const client = createClient<DeployPaths>({ baseUrl: DEPLOY_API_URL });
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
 * structured `DeployApiError` for non-2xx responses. Mirrors the
 * shape of cloud's own `unwrap` helper in `lib/api.ts` so call
 * sites read the same way.
 */
export function unwrapDeploy<T>(result: { data?: T; error?: unknown; response: Response }): T {
	if (result.error !== undefined || result.data === undefined) {
		throw new DeployApiError(
			result.response.status,
			extractApiDetail(result.error) ?? result.response.statusText,
		);
	}
	return result.data;
}

/**
 * Build the deep-link URL into clawdi.ai/dashboard for a given
 * deployment + runtime. The user clicks "Manage" on a hosted-agents
 * tile (one tile per onboarded runtime — OpenClaw and Hermes are
 * separate dashboard surfaces) and lands on the existing dashboard
 * with the right runtime pre-selected.
 *
 * Monorepo's `useAgentTypeStore.hydrateFromStorage` consumes the
 * `?agent_type=` query param so the sidebar dropdown reflects the
 * tile that was clicked, instead of falling back to whatever was
 * last picked in localStorage.
 *
 * Defaults to `https://www.clawdi.ai/dashboard`; override via
 * `NEXT_PUBLIC_DEPLOY_DASHBOARD_URL` (e.g. `clawdi.localhost:50020`
 * for the local Conductor worktree pair).
 */
export function deploymentManageUrl(deployment: Deployment, runtime?: string): string {
	const base = process.env.NEXT_PUBLIC_DEPLOY_DASHBOARD_URL || "https://www.clawdi.ai/dashboard";
	const params = new URLSearchParams({ deployment: deployment.id });
	if (runtime === "openclaw" || runtime === "hermes") {
		params.set("agent_type", runtime);
	}
	return `${base}?${params.toString()}`;
}
