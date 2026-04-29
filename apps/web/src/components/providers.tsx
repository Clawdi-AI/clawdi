"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { useState } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(() => new QueryClient());
	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
			<NuqsAdapter>
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delayDuration={200}>{children}</TooltipProvider>
				</QueryClientProvider>
			</NuqsAdapter>
		</ThemeProvider>
	);
}
