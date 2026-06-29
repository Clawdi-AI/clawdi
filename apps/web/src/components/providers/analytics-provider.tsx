"use client";

import type { ReactNode } from "react";
import dynamic from "@/lib/dynamic";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const HostedAnalyticsClient = IS_HOSTED_BUILD
	? dynamic(() =>
			import("@/hosted/analytics-client").then((m) => ({
				default: m.HostedAnalyticsClient,
			})),
		)
	: null;

export function AnalyticsProvider({ children }: { children: ReactNode }) {
	return (
		<>
			{children}
			{HostedAnalyticsClient ? <HostedAnalyticsClient /> : null}
		</>
	);
}
