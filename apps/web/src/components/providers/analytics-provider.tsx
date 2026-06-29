"use client";

import type { ReactNode } from "react";
import dynamic from "@/lib/dynamic";
import { IS_HOSTED } from "@/lib/hosted";

const HostedAnalyticsClient = IS_HOSTED
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
