"use client";

import { lazy, Suspense } from "react";
import { HostedProductGate } from "@/components/hosted-product-gate";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const DeployWizard = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/billing/deploy/deploy-wizard").then((m) => ({ default: m.DeployWizard })),
		)
	: null;

export default function Page() {
	return (
		<HostedProductGate fallbackHref="/">
			{DeployWizard ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<DeployWizard />
				</Suspense>
			) : null}
		</HostedProductGate>
	);
}
