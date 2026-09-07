"use client";

import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { AuthRouterBridge } from "@/components/auth-router-bridge";
import { AnalyticsProvider } from "@/components/providers/analytics-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
			<NuqsAdapter>
				<AuthRouterBridge>
					<AnalyticsProvider>
						<TooltipProvider delay={200}>{children}</TooltipProvider>
					</AnalyticsProvider>
				</AuthRouterBridge>
			</NuqsAdapter>
		</ThemeProvider>
	);
}
