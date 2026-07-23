"use client";

import type { DeployPaths } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import createClient from "openapi-fetch";
import { useAuthToken } from "@/lib/auth-client";
import { IS_HOSTED } from "@/lib/hosted";
import { DEPLOY_API_URL, hostedApiBaseUrl, isDeployApiConfigured } from "@/lib/hosted-api";
import {
	type HostedProductAccessProfile,
	hostedProductAccessFromProfile,
} from "@/lib/hosted-product-access-model";

export const hostedProductAccessKeys = {
	me: ["hosted-product-access", "me"] as const,
};

async function fetchHostedProductAccessProfile(
	getToken: () => Promise<string | null>,
): Promise<HostedProductAccessProfile> {
	const token = await getToken();
	const api = createClient<DeployPaths>({ baseUrl: hostedApiBaseUrl(DEPLOY_API_URL) });
	const result = await api.GET("/v1/me", {
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	});
	if (!result.response.ok) {
		throw new Error(`Hosted product access check failed with ${result.response.status}`);
	}
	if (!result.data) {
		throw new Error("Hosted product access check returned an empty profile");
	}
	return result.data;
}

export function useHostedProductAccess() {
	const { getToken } = useAuthToken();
	const enabled = IS_HOSTED && isDeployApiConfigured();
	const query = useQuery({
		queryKey: hostedProductAccessKeys.me,
		queryFn: () => fetchHostedProductAccessProfile(getToken),
		enabled,
		retry: false,
		staleTime: 60_000,
	});
	const access = hostedProductAccessFromProfile(query.data);
	return {
		...access,
		isLoading: enabled && query.isLoading,
		isFetching: enabled && query.isFetching,
		error: query.error,
		refetch: query.refetch,
		recheckCanCreateCloudAgents: async () => {
			const result = await query.refetch();
			if (result.error) throw result.error;
			return hostedProductAccessFromProfile(result.data).canCreateCloudAgents;
		},
	};
}
