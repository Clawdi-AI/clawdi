"use client";

import type { DeployPaths } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import createClient from "openapi-fetch";
import { useCallback, useMemo } from "react";
import { DEPLOY_API_URL, hostedApiBaseUrl, isDeployApiConfigured } from "@/hosted/access/api";
import {
	type HostedProductAccessProfile,
	hostedProductAccessFromProfile,
	hostedProductAccessStatus,
} from "@/hosted/access/product-access-model";
import {
	fetchHostedProductAccessWithTimeout,
	hostedProductAccessRetry,
} from "@/hosted/access/product-access-request";
import { ApiError } from "@/lib/api-errors";
import { useDashboardAuth } from "@/lib/auth-client";
import type { ProductAccess } from "@/lib/product-access";

export const hostedProductAccessKeys = {
	me: (userId: string) => ["hosted-product-access", "me", userId] as const,
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

export function useHostedProductAccessProfileQuery() {
	const { getToken, isSignedIn, userId } = useDashboardAuth();
	const enabled = isDeployApiConfigured() && Boolean(isSignedIn && userId);
	return useQuery({
		queryKey: hostedProductAccessKeys.me(userId ?? "signed-out"),
		queryFn: () => fetchHostedProductAccessProfile(getToken),
		enabled,
		retry: hostedProductAccessRetry,
		staleTime: 60_000,
	});
}

export function useHostedProductAccessQuery(): Omit<ProductAccess, "legacyDashboardUrl"> {
	const enabled = isDeployApiConfigured();
	const query = useHostedProductAccessProfileQuery();
	const access = useMemo(() => hostedProductAccessFromProfile(query.data), [query.data]);
	const status = hostedProductAccessStatus({
		enabled,
		profile: query.data,
		isFetching: query.isFetching,
		error: query.error,
	});
	const refetchQuery = query.refetch;
	const refetch = useCallback(async () => {
		await refetchQuery();
	}, [refetchQuery]);
	const recheckCanCreateCloudAgents = useCallback(async () => {
		const result = await refetchQuery();
		if (result.error) throw result.error;
		return hostedProductAccessFromProfile(result.data).canCreateCloudAgents;
	}, [refetchQuery]);
	return useMemo(
		() => ({
			...access,
			status,
			isLoading: status === "loading",
			isError: status === "error",
			isAllowed: status === "allowed",
			isDenied: status === "denied",
			isFetching: enabled && query.isFetching,
			error: query.error,
			refetch,
			recheckCanCreateCloudAgents,
		}),
		[access, enabled, query.error, query.isFetching, recheckCanCreateCloudAgents, refetch, status],
	);
}
