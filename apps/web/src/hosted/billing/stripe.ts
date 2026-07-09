import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;

export function getStripe(key: string): Promise<Stripe | null> {
	if (!stripePromise) stripePromise = loadStripe(key);
	return stripePromise;
}

export function resetStripeCache() {
	stripePromise = null;
}

/**
 * Stripe's React Embedded Checkout wrapper doesn't surface initialization
 * failures. Preflight one checkout instance so the caller can fall back before
 * showing a blank dialog, then destroy it and let the real provider remount.
 */
export async function preflightEmbeddedCheckout(
	key: string,
	clientSecret: string,
): Promise<Stripe> {
	const stripe = await getStripe(key);
	if (!stripe) {
		throw new Error("Stripe.js failed to initialize.");
	}
	const embeddedCheckout = await stripe.createEmbeddedCheckoutPage({ clientSecret });
	embeddedCheckout.destroy();
	return stripe;
}
