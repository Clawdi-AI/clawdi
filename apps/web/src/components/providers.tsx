"use client";

import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { lazy, Suspense } from "react";
import { AuthRouterBridge } from "@/components/auth-router-bridge";
import { AnalyticsProvider } from "@/components/providers/analytics-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

const ChatwootClient =
	import.meta.env.VITE_CLAWDI_DESKTOP_BUILD !== "true" &&
	import.meta.env.VITE_CHATWOOT_BASE_URL &&
	import.meta.env.VITE_CHATWOOT_WEBSITE_TOKEN
		? lazy(() =>
				import("@/components/chatwoot-client").then((module) => ({
					default: module.ChatwootClient,
				})),
			)
		: null;

export function Providers({ children }: { children: React.ReactNode }) {
	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
			<NuqsAdapter>
				<AuthRouterBridge>
					<AnalyticsProvider>
						<TooltipProvider delay={200}>{children}</TooltipProvider>
						{ChatwootClient ? (
							<Suspense fallback={null}>
								<ChatwootClient />
							</Suspense>
						) : null}
					</AnalyticsProvider>
				</AuthRouterBridge>
			</NuqsAdapter>
		</ThemeProvider>
	);
}
