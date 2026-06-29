"use client";

import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import dynamic from "@/lib/dynamic";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// V2-gated surface. The dynamic import is constructed only when hosted build is
// true so OSS builds eliminate the chunk entirely.
const AiProvidersPage = IS_HOSTED_BUILD
	? dynamic(
			() =>
				import("@/v2/ai-providers/ai-providers-page").then((m) => ({
					default: m.AiProvidersPage,
				})),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return <V2Gate fallbackHref="/">{AiProvidersPage ? <AiProvidersPage /> : null}</V2Gate>;
}
