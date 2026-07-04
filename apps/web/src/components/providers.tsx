"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { useEffect, useRef, useState } from "react";
import { AnalyticsProvider } from "@/components/providers/analytics-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api-errors";
import { useCurrentUser } from "@/lib/auth-client";

export function Providers({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						staleTime: 30_000,
						retry: (failureCount, error) => {
							if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
								return false;
							}
							return failureCount < 2;
						},
					},
				},
			}),
	);
	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
			<NuqsAdapter>
				<QueryClientProvider client={queryClient}>
					<QueryCacheAuthBoundary queryClient={queryClient}>
						<AnalyticsProvider>
							<TooltipProvider delay={200}>{children}</TooltipProvider>
						</AnalyticsProvider>
					</QueryCacheAuthBoundary>
				</QueryClientProvider>
			</NuqsAdapter>
		</ThemeProvider>
	);
}

function QueryCacheAuthBoundary({
	children,
	queryClient,
}: {
	children: React.ReactNode;
	queryClient: QueryClient;
}) {
	const { isLoaded, isSignedIn, user } = useCurrentUser();
	const lastAuthKey = useRef<string | null>(null);

	useEffect(() => {
		if (!isLoaded) return;

		const authKey = isSignedIn ? (user?.id ?? "signed-in") : "signed-out";
		if (lastAuthKey.current === null) {
			lastAuthKey.current = authKey;
			return;
		}
		if (lastAuthKey.current !== authKey) {
			queryClient.clear();
			lastAuthKey.current = authKey;
		}
	}, [isLoaded, isSignedIn, queryClient, user?.id]);

	return children;
}
