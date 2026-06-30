"use client";

import { lazy, type ReactNode, Suspense } from "react";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const HostedAnalyticsClient = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/analytics-client").then((m) => ({
				default: m.HostedAnalyticsClient,
			})),
		)
	: null;

export function AnalyticsProvider({ children }: { children: ReactNode }) {
	return (
		<>
			{children}
			{HostedAnalyticsClient ? (
				<Suspense fallback={null}>
					<HostedAnalyticsClient />
				</Suspense>
			) : null}
		</>
	);
}
