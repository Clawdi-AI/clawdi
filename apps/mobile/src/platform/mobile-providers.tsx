import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { MobileApiProvider } from "@/lib/api-provider";
import type { MobileRuntimeConfig } from "@/lib/config/runtime";
import { AccountScopeProvider } from "@/platform/account-lifecycle";
import { AppLifecycleBridge } from "@/platform/app-lifecycle";
import { PaywallHost } from "@/platform/store/paywall-host";
import { StoreProvider } from "@/platform/store/store-provider";

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
					<StoreProvider config={config}>
						<PaywallHost>
							<AppLifecycleBridge>{children}</AppLifecycleBridge>
						</PaywallHost>
					</StoreProvider>
				</MobileApiProvider>
			</AccountScopeProvider>
		</QueryClientProvider>
	);
}
