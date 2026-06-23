"use client";

import type { DeployPaths } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import createClient from "openapi-fetch";
import { useAuthToken } from "@/lib/auth-client";
import { IS_HOSTED } from "@/lib/hosted";
import { DEPLOY_API_URL, hostedApiBaseUrl, isDeployApiConfigured } from "@/lib/hosted-api";
import { type V2AccessProfile, v2AccessFromProfile } from "@/lib/v2-access-model";

export const v2AccessKeys = {
	me: ["v2-access", "me"] as const,
};

async function fetchV2AccessProfile(
	getToken: () => Promise<string | null>,
): Promise<V2AccessProfile> {
	const token = await getToken();
	const api = createClient<DeployPaths>({ baseUrl: hostedApiBaseUrl(DEPLOY_API_URL) });
	const result = await api.GET("/me", {
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	});
	if (!result.response.ok) {
		throw new Error(`V2 access check failed with ${result.response.status}`);
	}
	if (!result.data) {
		throw new Error("V2 access check returned an empty profile");
	}
	return result.data;
}

export function useV2Access() {
	const { getToken } = useAuthToken();
	const enabled = IS_HOSTED && isDeployApiConfigured();
	const query = useQuery({
		queryKey: v2AccessKeys.me,
		queryFn: () => fetchV2AccessProfile(getToken),
		enabled,
		retry: false,
		staleTime: 60_000,
	});
	const access = v2AccessFromProfile(query.data);
	return {
		...access,
		isLoading: enabled && query.isLoading,
		isFetching: enabled && query.isFetching,
		error: query.error,
		refetch: query.refetch,
	};
}
