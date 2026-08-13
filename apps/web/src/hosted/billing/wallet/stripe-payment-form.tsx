"use client";

import { PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { AlertCircle } from "lucide-react";
import { useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { PaymentIntentClientSecret } from "@/hosted/billing/stripe-client-secret";
import { StripeElementsProvider } from "@/hosted/billing/stripe-elements-provider";
import {
	type PaymentOutcome,
	paymentOutcomeForStatus,
} from "@/hosted/billing/wallet/stripe-payment-form.logic";
import { buildWalletTopupReturnUrl } from "@/hosted/billing/wallet/top-up-return.logic";

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
				setError(result.error.message ?? "We couldn't process that payment. Please try again.");
				finishSubmitting();
				return;
			}
			const status = result.paymentIntent?.status;
			const outcome = paymentOutcomeForStatus(status);
			if (!outcome) {
				setError(
					status === "requires_action"
						? "Your payment method needs confirmation. Complete the prompt, then select the payment button again."
						: "This payment is not ready to complete. Review the payment details and try again.",
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
	clientSecret: PaymentIntentClientSecret;
	onComplete: (status: PaymentOutcome) => void;
	onCancel: () => void;
	returnUrl?: PaymentReturnUrl;
	submitLabel?: string;
	summary?: string;
	onSubmittingChange?: (submitting: boolean) => void;
}) {
	return (
		<StripeElementsProvider clientSecret={clientSecret}>
			<InnerForm
				onComplete={onComplete}
				onCancel={onCancel}
				returnUrl={returnUrl}
				submitLabel={submitLabel}
				summary={summary}
				onSubmittingChange={onSubmittingChange}
			/>
		</StripeElementsProvider>
	);
}
