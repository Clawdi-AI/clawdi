import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { MobileApiProvider } from "@/components/api-provider";
import type { MobileRuntimeConfig } from "@/lib/config/runtime";
import { AccountScopeProvider } from "@/platform/account-lifecycle";
import { AppLifecycleBridge } from "@/platform/app-lifecycle";

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
