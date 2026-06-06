"use client";

import { type DeployPaths, extractApiDetail } from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { useMemo } from "react";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";

/**
 * Shared cross-origin client for the clawdi.ai backend.
 *
 * Both `useHostedAgentTiles` (deploy listing) and `useHostedConnectors`
 * (Composio passthrough) hit the same backend with the same Clerk JWT
 * pattern, so they share one factory instead of two near-identical
 * boilerplate copies. `DeployPaths` is misnamed — the generated dump
 * carries the full schema, including `/connections/*`.
 */

const CLAWDI_API_URL = env.NEXT_PUBLIC_DEPLOY_API_URL;

/**
 * Whether the deploy API can possibly be reached from this origin.
 *
 * `NEXT_PUBLIC_DEPLOY_API_URL` defaults to `http://localhost:50021`
 * (the SaaS backend's dev port). On any non-localhost deployment that
 * forgot to set it — preview environments, self-hosted mirrors — every
 * hosted fetch is dead on arrival and the dashboard showed a permanent
 * "Hosted agents unavailable" outage banner for what is really a
 * not-configured integration. Callers should skip hosted fetches
 * entirely when this is false; real outages on properly-configured
 * hosts still surface.
 */
export function isDeployApiConfigured(): boolean {
	if (!CLAWDI_API_URL.includes("//localhost") && !CLAWDI_API_URL.includes("//127.0.0.1")) {
		return true;
	}
	if (typeof window === "undefined") return true;
	const host = window.location.hostname;
	return host === "localhost" || host === "127.0.0.1";
}

class ClawdiApiError extends Error {
	constructor(
		public status: number,
		public detail: string,
	) {
		super(`Clawdi API ${status}: ${detail}`);
		this.name = "ClawdiApiError";
	}
}

export function useClawdiApi() {
	const { getToken } = useAuthToken();
	return useMemo(() => {
		const client = createClient<DeployPaths>({ baseUrl: CLAWDI_API_URL });
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

export function unwrapClawdi<T>(result: { data?: T; error?: unknown; response: Response }): T {
	if (result.error !== undefined || result.data === undefined) {
		throw new ClawdiApiError(
			result.response.status,
			extractApiDetail(result.error) ?? result.response.statusText,
		);
	}
	return result.data;
}
