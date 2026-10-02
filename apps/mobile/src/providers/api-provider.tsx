import {
	ApiClientError,
	type ApiClientFetch,
	type CloudApiClient,
	createCloudApiClient,
} from "@clawdi/shared/api";
import { useAuth } from "@clerk/expo";
import { fetch as expoFetch } from "expo/fetch";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import type { MobileRuntimeConfig } from "../config/runtime";
import { useAccountScope } from "../platform/account-lifecycle";

export type MobileApiClients = Readonly<{
	cloud: CloudApiClient;
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
	const readToken = useCallback(async () => {
		if (!scope.isReady || !scope.isCurrent() || sessionId !== scope.sessionId) {
			throw new ApiClientError(401, "authentication_required");
		}
		const token = await getToken();
		if (!scope.isCurrent() || sessionId !== scope.sessionId) {
			throw new ApiClientError(401, "authentication_required");
		}
		return token;
	}, [getToken, scope, sessionId]);
	const fetcher = useCallback<ApiClientFetch>((request, init) => expoFetch(request.url, init), []);
	const clients = useMemo<MobileApiClients>(
		() => ({
			cloud: createCloudApiClient({
				baseUrl: config.cloudApiUrl,
				getToken: readToken,
				fetch: fetcher,
			}),
		}),
		[config.cloudApiUrl, fetcher, readToken],
	);
	return <MobileApiContext.Provider value={clients}>{children}</MobileApiContext.Provider>;
}

export function useMobileApi(): MobileApiClients {
	const clients = useContext(MobileApiContext);
	if (!clients) throw new Error("useMobileApi must be used inside MobileApiProvider");
	return clients;
}
