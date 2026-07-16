"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getStripe, resetStripeCache } from "@/hosted/billing/stripe";
import {
	type PaymentOutcome,
	paymentOutcomeForStatus,
} from "@/hosted/billing/wallet/stripe-payment-form.logic";
import { buildWalletTopupReturnUrl } from "@/hosted/billing/wallet/top-up-return.logic";
import { env } from "@/lib/env";

export type { PaymentOutcome } from "@/hosted/billing/wallet/stripe-payment-form.logic";

type PaymentReturnUrl = (currentHref: string) => string;

function InnerForm({
	onComplete,
	onCancel,
	returnUrl,
	submitLabel,
	summary,
	onSubmittingChange,
}: {
	onComplete: (status: PaymentOutcome) => void;
	onCancel: () => void;
	returnUrl: PaymentReturnUrl;
	submitLabel: string;
	summary?: string;
	onSubmittingChange?: (submitting: boolean) => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submittingRef = useRef(false);

	function finishSubmitting() {
		submittingRef.current = false;
		setSubmitting(false);
		onSubmittingChange?.(false);
	}

	async function pay() {
		if (!stripe || !elements || submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		onSubmittingChange?.(true);
		setError(null);
		try {
			const result = await stripe.confirmPayment({
				elements,
				redirect: "if_required",
				confirmParams: {
					return_url: returnUrl(window.location.href),
				},
			});
			if (result.error) {
				setError(result.error.message ?? "We couldn't process that card. Please try again.");
				finishSubmitting();
				return;
			}
			const status = result.paymentIntent?.status;
			const outcome = paymentOutcomeForStatus(status);
			if (!outcome) {
				setError(
					status === "requires_action"
						? "Your bank needs to confirm this payment. Complete the prompt, then select the payment button again."
						: "This payment is not ready to complete. Review the card details and try again.",
				);
				finishSubmitting();
				return;
			}
			onComplete(outcome);
		} catch {
			setError("We couldn't reach Stripe. Check your connection and try again.");
			finishSubmitting();
		}
	}

	return (
		<div data-hosted="true" className="flex flex-col gap-3">
			{summary ? <p className="text-sm font-medium tabular-nums">{summary}</p> : null}
			<PaymentElement />
			{error ? (
				<Alert variant="destructive">
					<AlertCircle aria-hidden />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
					Back
				</Button>
				<Button type="button" onClick={pay} disabled={!stripe || submitting}>
					{submitting ? (
						<>
							<Spinner data-icon="inline-start" /> Processing…
						</>
					) : (
						submitLabel
					)}
				</Button>
			</div>
		</div>
	);
}

export function StripePaymentForm({
	clientSecret,
	onComplete,
	onCancel,
	returnUrl = buildWalletTopupReturnUrl,
	submitLabel = "Confirm payment",
	summary,
	onSubmittingChange,
}: {
	clientSecret: string;
	onComplete: (status: PaymentOutcome) => void;
	onCancel: () => void;
	returnUrl?: PaymentReturnUrl;
	submitLabel?: string;
	summary?: string;
	onSubmittingChange?: (submitting: boolean) => void;
}) {
	const key = env.VITE_STRIPE_PUBLISHABLE_KEY;
	const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!key) return;
		let cancelled = false;
		setStripe(undefined);
		getStripe(key)
			.then((nextStripe) => {
				if (!cancelled) setStripe(nextStripe);
			})
			.catch(() => {
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
				<AlertCircle aria-hidden />
				<AlertDescription>
					Card payments aren’t configured in this environment. Set a Stripe publishable key to
					continue.
				</AlertDescription>
			</Alert>
		);
	}

	if (stripe === null) {
		return (
			<Alert data-hosted="true" variant="destructive">
				<AlertCircle aria-hidden />
				<AlertDescription className="flex flex-col items-start gap-3">
					<span>
						We couldn’t load the secure payment form. Check your connection or ad blocker and try
						again.
					</span>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => {
							resetStripeCache();
							setAttempt((current) => current + 1);
						}}
					>
						<RefreshCw data-icon="inline-start" /> Retry payment form
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
				<Spinner data-icon="inline-start" /> Loading secure payment…
			</div>
		);
	}

	return (
		<div data-hosted="true">
			<Elements stripe={stripe} options={{ clientSecret, appearance: { theme: "stripe" } }}>
				<InnerForm
					onComplete={onComplete}
					onCancel={onCancel}
					returnUrl={returnUrl}
					submitLabel={submitLabel}
					summary={summary}
					onSubmittingChange={onSubmittingChange}
				/>
			</Elements>
		</div>
	);
}
