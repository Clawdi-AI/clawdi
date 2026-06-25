"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { env } from "@/lib/env";

/**
 * Stripe.js singleton. `loadStripe` injects the v3 script; keep one promise so
 * remounting the top-up dialog doesn't re-inject it. `resetStripeCache` clears
 * it so a retry after a failed (network) load actually re-injects rather than
 * re-awaiting the same rejected promise.
 */
let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(key: string): Promise<Stripe | null> {
	if (!stripePromise) stripePromise = loadStripe(key);
	return stripePromise;
}
function resetStripeCache() {
	stripePromise = null;
}

/** Terminal outcomes only — `requires_action` (3DS) is resolved inside the form. */
export type PaymentOutcome = "succeeded" | "processing";

function InnerForm({
	onComplete,
	onCancel,
}: {
	onComplete: (status: PaymentOutcome) => void;
	onCancel: () => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function pay() {
		// Guard re-entry: the button disables on submit, but a fast double-tap
		// could still queue a second confirmPayment before React repaints.
		if (!stripe || !elements || submitting) return;
		setSubmitting(true);
		setError(null);
		// `redirect: "if_required"` keeps card payments inline; only methods that
		// truly need a redirect (some wallets) navigate away.
		try {
			const result = await stripe.confirmPayment({ elements, redirect: "if_required" });
			if (result.error) {
				setError(result.error.message ?? "We couldn't process that card. Please try again.");
				setSubmitting(false);
				return;
			}
			const status = result.paymentIntent?.status;
			if (status === "requires_action") {
				// Stripe couldn't complete the bank confirmation inline (the prompt was
				// dismissed, or it needs another pass). Keep the form mounted with a
				// clear next step rather than closing on an unconfirmed payment.
				setError(
					"Your bank needs to confirm this payment. Complete the prompt, then tap Pay again.",
				);
				setSubmitting(false);
				return;
			}
			onComplete(status === "succeeded" ? "succeeded" : "processing");
		} catch {
			setError("We couldn't reach Stripe. Check your connection and try again.");
			setSubmitting(false);
		}
	}

	return (
		<div data-hosted="true" className="space-y-3">
			<PaymentElement />
			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex justify-end gap-2">
				<Button variant="ghost" onClick={onCancel} disabled={submitting}>
					Back
				</Button>
				<Button onClick={pay} disabled={!stripe || submitting}>
					{submitting ? (
						<>
							<Spinner /> Processing…
						</>
					) : (
						"Pay now"
					)}
				</Button>
			</div>
		</div>
	);
}

/**
 * Card-confirmation step for a wallet top-up PaymentIntent. Mounts Stripe
 * Elements against the `client_secret` from `POST /wallet/topup`.
 *
 * Three degrade paths so the dialog never silently breaks:
 *  - no publishable key (OSS / preview) → explicit configuration error.
 *  - Stripe.js fails to load (network / blocked script) → explicit error +
 *    Retry that re-injects the script (rather than mounting `Elements` against
 *    a rejected promise, which renders nothing).
 *  - still loading → a spinner instead of a blank gap.
 */
export function StripePaymentForm({
	clientSecret,
	onComplete,
	onCancel,
}: {
	clientSecret: string;
	onComplete: (status: PaymentOutcome) => void;
	onCancel: () => void;
}) {
	const key = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
	// undefined = loading, null = load failed, Stripe = ready.
	const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!key) return;
		let cancelled = false;
		setStripe(undefined);
		getStripe(key)
			.then((s) => {
				if (!cancelled) setStripe(s);
			})
			.catch(() => {
				// Drop the rejected singleton so the next attempt re-injects.
				resetStripeCache();
				if (!cancelled) setStripe(null);
			});
		return () => {
			cancelled = true;
		};
	}, [key, attempt]);

	if (!key) {
		return (
			<Alert data-hosted="true">
				<AlertCircle />
				<AlertDescription>
					Card payments aren’t configured in this environment. Set a Stripe publishable key to top
					up.
				</AlertDescription>
			</Alert>
		);
	}

	if (stripe === null) {
		return (
			<Alert data-hosted="true" variant="destructive">
				<AlertCircle />
				<AlertDescription className="flex flex-col items-start gap-3">
					<span>
						We couldn’t load the secure payment form. Check your connection (or any ad-blocker) and
						try again.
					</span>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							resetStripeCache();
							setAttempt((a) => a + 1);
						}}
					>
						<RefreshCw /> Retry
					</Button>
				</AlertDescription>
			</Alert>
		);
	}

	if (stripe === undefined) {
		return (
			<div
				data-hosted="true"
				className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
			>
				<Spinner /> Loading secure payment…
			</div>
		);
	}

	return (
		<div data-hosted="true">
			<Elements stripe={stripe} options={{ clientSecret, appearance: { theme: "stripe" } }}>
				<InnerForm onComplete={onComplete} onCancel={onCancel} />
			</Elements>
		</div>
	);
}
