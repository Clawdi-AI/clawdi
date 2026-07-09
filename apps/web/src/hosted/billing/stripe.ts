import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;

export function getStripe(key: string): Promise<Stripe | null> {
	if (!stripePromise) stripePromise = loadStripe(key);
	return stripePromise;
}

export function resetStripeCache() {
	stripePromise = null;
}
