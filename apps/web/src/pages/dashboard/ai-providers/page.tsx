"use client";

import { lazy } from "react";
import { HostedProductRoute } from "@/components/hosted-product-route";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// Hosted product surface. The dynamic import is constructed only when hosted
// build is true so OSS builds eliminate the chunk entirely.
const AiProvidersPage = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/v2/ai-providers/ai-providers-page").then((m) => ({
				default: m.AiProvidersPage,
			})),
		)
	: null;

export default function Page() {
	return AiProvidersPage ? (
		<HostedProductRoute>
			<AiProvidersPage />
		</HostedProductRoute>
	) : null;
}
