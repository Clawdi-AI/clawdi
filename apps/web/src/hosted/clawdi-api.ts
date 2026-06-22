"use client";

import { type DeployPaths, extractApiDetail } from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { useMemo } from "react";
import { useAuthToken } from "@/lib/auth-client";
import { DEPLOY_API_URL, isDeployApiConfigured } from "@/lib/hosted-api";

/**
 * Shared cross-origin client for the clawdi.ai backend.
 *
 * Both `useHostedAgentTiles` (deploy listing) and `useHostedConnectors`
 * (Composio passthrough) hit the same backend with the same Clerk JWT
 * pattern, so they share one factory instead of two near-identical
 * boilerplate copies. `DeployPaths` is misnamed — the generated dump
 * carries the full schema, including `/connections/*`.
 */

const CLAWDI_API_URL = DEPLOY_API_URL;

export { isDeployApiConfigured };

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
