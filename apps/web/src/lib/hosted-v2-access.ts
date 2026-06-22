"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuthToken } from "@/lib/auth-client";
import { IS_HOSTED } from "@/lib/hosted";
import { DEPLOY_API_URL, hostedApiBaseUrl, isDeployApiConfigured } from "@/lib/hosted-api";
import { type HostedAccessProfile, hostedV2AccessFromProfile } from "@/lib/hosted-v2-access-model";

export const hostedV2AccessKeys = {
	me: ["hosted", "v2-access", "me"] as const,
};

async function fetchHostedAccessProfile(
	getToken: () => Promise<string | null>,
): Promise<HostedAccessProfile> {
	const token = await getToken();
	const headers = new Headers();
	if (token) headers.set("Authorization", `Bearer ${token}`);
	const response = await fetch(`${hostedApiBaseUrl(DEPLOY_API_URL)}/me`, { headers });
	if (!response.ok) {
		throw new Error(`Hosted access check failed with ${response.status}`);
	}
	return (await response.json()) as HostedAccessProfile;
}

export function useHostedV2Access() {
	const { getToken } = useAuthToken();
	const enabled = IS_HOSTED && isDeployApiConfigured();
	const query = useQuery({
		queryKey: hostedV2AccessKeys.me,
		queryFn: () => fetchHostedAccessProfile(getToken),
		enabled,
		retry: false,
		staleTime: 60_000,
	});
	const access = hostedV2AccessFromProfile(query.data);
	return {
		...access,
		isLoading: enabled && query.isLoading,
		isFetching: enabled && query.isFetching,
		error: query.error,
		refetch: query.refetch,
	};
}
