import {
	type AccountApiClient,
	ApiClientError,
	type ApiClientFetch,
	type CloudApiClient,
	createAccountApiClient,
	createCloudApiClient,
	createHostedApiClient,
	createHostedComputeClient,
	type HostedApiClient,
	type HostedComputeClient,
} from "@clawdi/shared/api";
import { useAuth } from "@clerk/expo";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import type { MobileRuntimeConfig } from "../config/runtime";
import { useAccountScope } from "../platform/account-lifecycle";

export type MobileApiClients = Readonly<{
	cloud: CloudApiClient;
	account: AccountApiClient;
	compute: HostedComputeClient | null;
	hosted: HostedApiClient | null;
}>;

const MobileApiContext = createContext<MobileApiClients | null>(null);

export function MobileApiProvider({
	children,
	config,
}: {
	children: ReactNode;
	config: MobileRuntimeConfig;
}) {
	const scope = useAccountScope();
	const { getToken, sessionId } = useAuth();
	const readToken = useCallback(async (): Promise<string | null> => {
		const scopeSignal = scope.signal;
		if (
			!scope.isReady ||
			!scope.isCurrent() ||
			scopeSignal.aborted ||
			sessionId !== scope.sessionId
		) {
			throw new ApiClientError(401, "authentication_required");
		}
		const token = await getToken();
		if (!scope.isCurrent() || scopeSignal.aborted || sessionId !== scope.sessionId) {
			throw new ApiClientError(401, "authentication_required");
		}
		return token ?? null;
	}, [getToken, scope, sessionId]);
	const fetcher = useCallback<ApiClientFetch>(
		(request, init) => globalThis.fetch(request, init),
		[],
	);
	const clients = useMemo<MobileApiClients>(
		() => ({
			cloud: createCloudApiClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			account: createAccountApiClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
			compute: config.computeApiUrl
				? createHostedComputeClient({
						baseUrl: config.computeApiUrl,
						getToken: readToken,
						fetch: fetcher,
					})
				: null,
			hosted: config.computeApiUrl
				? createHostedApiClient({
						baseUrl: config.computeApiUrl,
						getToken: readToken,
						fetch: fetcher,
					})
				: null,
		}),
		[config.cloudApiUrl, config.computeApiUrl, fetcher, readToken],
	);
	return <MobileApiContext.Provider value={clients}>{children}</MobileApiContext.Provider>;
}

export function useMobileApi(): MobileApiClients {
	const clients = useContext(MobileApiContext);
	if (!clients) throw new Error("useMobileApi must be used inside MobileApiProvider");
	return clients;
}
