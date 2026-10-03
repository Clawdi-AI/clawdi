import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, setResponseHeader } from "@tanstack/react-start/server";
import { createBillingClient } from "@/hosted/billing/billing-client";
import { TRIAL_OFFER_COOKIE } from "@/hosted/billing/trial-offer.server";

export const getTrialOffer = createServerFn({ method: "GET" }).handler(async () => {
	setResponseHeader("Cache-Control", "private, no-store");
	const identity = await auth();
	const token = getCookie(TRIAL_OFFER_COOKIE);
	if (!identity.userId || !token) return null;
	return createBillingClient(async () => {
		const accessToken = await identity.getToken();
		if (!accessToken) throw new Error("Sign in to check trial availability.");
		return accessToken;
	}).resolveTrialOffer({ token });
});

// Read only at submission time; never put the credential in query or mutation caches.
export const getTrialOfferToken = createServerFn({ method: "GET" }).handler(async () => {
	setResponseHeader("Cache-Control", "private, no-store");
	const { userId } = await auth();
	return userId ? (getCookie(TRIAL_OFFER_COOKIE) ?? null) : null;
});
