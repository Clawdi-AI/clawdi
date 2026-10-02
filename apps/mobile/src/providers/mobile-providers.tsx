import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { MobileRuntimeConfig } from "../config/runtime";
import { AppLifecycleBridge } from "../platform/app-lifecycle";
import { AccountScopeProvider } from "../platform/account-lifecycle";
import { MobileApiProvider } from "./api-provider";

function createMobileQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				retry: 1,
			},
		},
	});
}

export function MobileProviders({
	children,
	config,
}: {
	children: ReactNode;
	config: MobileRuntimeConfig;
}) {
	const [queryClient] = useState(createMobileQueryClient);
	return (
		<QueryClientProvider client={queryClient}>
			<AccountScopeProvider>
				<MobileApiProvider config={config}>
					<AppLifecycleBridge>{children}</AppLifecycleBridge>
				</MobileApiProvider>
			</AccountScopeProvider>
		</QueryClientProvider>
	);
}
