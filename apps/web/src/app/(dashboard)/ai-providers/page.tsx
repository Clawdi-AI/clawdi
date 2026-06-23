"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import { IS_HOSTED } from "@/lib/hosted";

// V2-gated surface. The dynamic import is constructed only when `IS_HOSTED` is
// true so OSS builds eliminate the chunk entirely.
const AiProvidersPage = IS_HOSTED
	? dynamic(
			() =>
				import("@/v2/ai-providers/ai-providers-page").then((m) => ({
					default: m.AiProvidersPage,
				})),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return AiProvidersPage ? (
		<V2Gate fallbackHref="/">
			<AiProvidersPage />
		</V2Gate>
	) : null;
}
