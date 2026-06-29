"use client";

import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import dynamic from "@/lib/dynamic";
import { IS_HOSTED } from "@/lib/hosted";

const DeployWizard = IS_HOSTED
	? dynamic(
			() =>
				import("@/hosted/billing/deploy/deploy-wizard").then((m) => ({ default: m.DeployWizard })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return <V2Gate fallbackHref="/">{DeployWizard ? <DeployWizard /> : null}</V2Gate>;
}
