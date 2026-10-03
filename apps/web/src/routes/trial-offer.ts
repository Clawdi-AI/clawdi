import { createFileRoute } from "@tanstack/react-router";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";
const loadTrialOfferHandler = IS_HOSTED_BUILD
	? () => import("@/hosted/billing/trial-offer.server")
	: null;

export const Route = createFileRoute("/trial-offer")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!loadTrialOfferHandler) return new Response(null, { status: 404 });
				return (await loadTrialOfferHandler()).receiveTrialOffer(request);
			},
		},
	},
});
