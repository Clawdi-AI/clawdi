"use client";

import type { DeployPaths } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import createClient from "openapi-fetch";
import { ApiError } from "@/lib/api-errors";
import { useAuthToken } from "@/lib/auth-client";
import { IS_HOSTED } from "@/lib/hosted";
import { DEPLOY_API_URL, hostedApiBaseUrl, isDeployApiConfigured } from "@/lib/hosted-api";
import {
	type HostedProductAccessProfile,
	hostedProductAccessFromProfile,
	hostedProductAccessStatus,
} from "@/lib/hosted-product-access-model";
import {
	fetchHostedProductAccessWithTimeout,
	hostedProductAccessRetry,
} from "@/lib/hosted-product-access-request";

export const hostedProductAccessKeys = {
	me: ["hosted-product-access", "me"] as const,
};

async function fetchHostedProductAccessProfile(
	getToken: () => Promise<string | null>,
): Promise<HostedProductAccessProfile> {
	const token = await getToken();
	const api = createClient<DeployPaths>({
		baseUrl: hostedApiBaseUrl(DEPLOY_API_URL),
		fetch: fetchHostedProductAccessWithTimeout,
	});
	const result = await api.GET("/v1/me", {
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	});
	if (!result.response.ok) {
		throw new ApiError(
			result.response.status,
			result.response.statusText || "Hosted product access check failed",
		);
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
		retry: hostedProductAccessRetry,
		staleTime: 60_000,
	});
	const access = hostedProductAccessFromProfile(query.data);
	const status = hostedProductAccessStatus({
		enabled,
		profile: query.data,
		isFetching: query.isFetching,
		error: query.error,
	});
	return {
		...access,
		status,
		isLoading: status === "loading",
		isError: status === "error",
		isAllowed: status === "allowed",
		isDenied: status === "denied",
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
