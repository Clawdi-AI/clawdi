"use client";

import { useQuery } from "@tanstack/react-query";
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
	const headers = new Headers();
	if (token) headers.set("Authorization", `Bearer ${token}`);
	const response = await fetch(`${hostedApiBaseUrl(DEPLOY_API_URL)}/me`, { headers });
	if (!response.ok) {
		throw new Error(`V2 access check failed with ${response.status}`);
	}
	return (await response.json()) as V2AccessProfile;
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
