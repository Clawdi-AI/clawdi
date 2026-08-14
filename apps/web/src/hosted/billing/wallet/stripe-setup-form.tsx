"use client";

import { PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { AlertCircle } from "lucide-react";
import { useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { StripeElementsProvider } from "@/hosted/billing/stripe-elements-provider";
import { buildWalletSetupReturnUrl } from "@/hosted/billing/wallet/setup-return.logic";
import { walletSetupIntentMatchesClientSecret } from "@/lib/wallet-stripe-return";

export interface WalletSetupConfirmed {
	setupIdentity: string;
	setupIntentId: string;
}

function SetupForm({
	clientSecret,
	setupIdentity,
	expectedSetupIntentId,
	confirmed,
	onCancel,
	onConfirmed,
	onSubmittingChange,
}: {
	clientSecret: string;
	setupIdentity: string;
	expectedSetupIntentId: string;
	confirmed: WalletSetupConfirmed | null;
	onCancel: () => void;
	onConfirmed: (result: WalletSetupConfirmed) => Promise<void>;
	onSubmittingChange?: (submitting: boolean) => void;
}) {
	const stripe = useStripe();
	const elements = useElements();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submittingRef = useRef(false);
	const reusableConfirmation =
		confirmed?.setupIdentity === setupIdentity &&
		confirmed.setupIntentId === expectedSetupIntentId &&
		walletSetupIntentMatchesClientSecret(clientSecret, confirmed.setupIntentId)
			? confirmed
			: null;

	function finishSubmitting() {
		submittingRef.current = false;
		setSubmitting(false);
		onSubmittingChange?.(false);
	}

	async function authorize() {
		if (submittingRef.current || (!reusableConfirmation && (!stripe || !elements))) return;
		submittingRef.current = true;
		setSubmitting(true);
		onSubmittingChange?.(true);
		setError(null);
		let nextConfirmed: WalletSetupConfirmed;
		if (reusableConfirmation) {
			nextConfirmed = reusableConfirmation;
		} else {
			if (!stripe || !elements) {
				finishSubmitting();
				return;
			}
			try {
				const confirmation = await stripe.confirmSetup({
					elements,
					redirect: "if_required",
					confirmParams: {
						return_url: buildWalletSetupReturnUrl(window.location.href, setupIdentity),
					},
				});
				if (confirmation.error) {
					setError(
						confirmation.error.message ??
							"We couldn't authorize that card. Review the details and try again.",
					);
					finishSubmitting();
					return;
				}
				const setupIntent = confirmation.setupIntent;
				if (
					setupIntent?.status !== "succeeded" ||
					setupIntent.id !== expectedSetupIntentId ||
					!walletSetupIntentMatchesClientSecret(clientSecret, setupIntent.id)
				) {
					setError(
						"The card authorization isn't complete. Finish any required confirmation and try again.",
					);
					finishSubmitting();
					return;
				}
				nextConfirmed = { setupIdentity, setupIntentId: setupIntent.id };
			} catch {
				setError("We couldn't reach the secure card service. Check your connection and try again.");
				finishSubmitting();
				return;
			}
		}
		try {
			await onConfirmed(nextConfirmed);
			finishSubmitting();
		} catch (nextError) {
			setError(normalizeBillingError(nextError));
			finishSubmitting();
		}
	}

	return (
		<div data-hosted="true" className="flex flex-col gap-4">
			<PaymentElement />
			{error ? (
				<Alert variant="destructive">
					<AlertCircle aria-hidden />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
				<Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
					Cancel
				</Button>
				<Button
					type="button"
					onClick={authorize}
					disabled={(!reusableConfirmation && !stripe) || submitting}
				>
					{submitting ? (
						<>
							<Spinner data-icon="inline-start" />{" "}
							{reusableConfirmation ? "Enabling…" : "Authorizing…"}
						</>
					) : reusableConfirmation ? (
						"Retry enabling auto-reload"
					) : (
						"Authorize card and enable auto-reload"
					)}
				</Button>
			</div>
		</div>
	);
}

export function StripeSetupForm({
	clientSecret,
	setupIdentity,
	expectedSetupIntentId,
	confirmed,
	onCancel,
	onConfirmed,
	onSubmittingChange,
}: {
	clientSecret: string;
	setupIdentity: string;
	expectedSetupIntentId: string;
	confirmed: WalletSetupConfirmed | null;
	onCancel: () => void;
	onConfirmed: (result: WalletSetupConfirmed) => Promise<void>;
	onSubmittingChange?: (submitting: boolean) => void;
}) {
	return (
		<StripeElementsProvider clientSecret={clientSecret}>
			<SetupForm
				clientSecret={clientSecret}
				setupIdentity={setupIdentity}
				expectedSetupIntentId={expectedSetupIntentId}
				confirmed={confirmed}
				onCancel={onCancel}
				onConfirmed={onConfirmed}
				onSubmittingChange={onSubmittingChange}
			/>
		</StripeElementsProvider>
	);
}
