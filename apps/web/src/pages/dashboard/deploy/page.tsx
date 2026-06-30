"use client";

import { lazy, Suspense } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const DeployWizard = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/billing/deploy/deploy-wizard").then((m) => ({ default: m.DeployWizard })),
		)
	: null;

export default function Page() {
	return (
		<V2Gate fallbackHref="/">
			{DeployWizard ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<DeployWizard />
				</Suspense>
			) : null}
		</V2Gate>
	);
}
