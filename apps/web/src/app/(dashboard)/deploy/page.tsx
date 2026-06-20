"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";

const DeployWizard = IS_HOSTED
	? dynamic(
			() =>
				import("@/hosted/billing/deploy/deploy-wizard").then((m) => ({ default: m.DeployWizard })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return DeployWizard ? <DeployWizard /> : null;
}
