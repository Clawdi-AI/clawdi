"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CreditCard, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { WalletState } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/hooks";
import {
	type PaymentOutcome,
	StripePaymentForm,
} from "@/hosted/billing/wallet/stripe-payment-form";

/**
 * SCA / decline-recovery control for a pending auto-reload. When the wallet
 * carries a `auto_reload_action` with a `client_secret`, the user can complete
 * the bank confirmation (SCA) or retry a declined charge right here: mounting
 * Stripe Elements against that PaymentIntent secret so the top-up actually
 * finishes from the dashboard.
 *
 * On success the wallet refetch clears `auto_reload_action`, so this control
 * unmounts itself. Without a `client_secret` (backend couldn't attach one) it
 * degrades to manual-top-up guidance.
 */
export function AutoReloadActionConfirm({
	wallet,
	onTopUp,
}: {
	wallet: WalletState;
	onTopUp?: () => void;
}) {
	const qc = useQueryClient();
	const [confirming, setConfirming] = useState(false);

	const action = wallet.auto_reload_action;
	if (!action) return null;

	const declined = action.error_code != null;
	const clientSecret = action.client_secret;
	const variant = declined ? "destructive" : "default";
	const title = declined ? "Last auto-reload was declined" : "Confirm your last auto-reload";

	function onComplete(status: PaymentOutcome) {
		// The wallet snapshot resolves `auto_reload_action` once the PaymentIntent
		// settles; refetch balance + activity so this control clears itself.
		qc.invalidateQueries({ queryKey: billingKeys.wallet });
		qc.invalidateQueries({ queryKey: ["billing", "ledger"] });
		setConfirming(false);
		toast.success(status === "succeeded" ? "Payment confirmed" : "Payment processing", {
			description:
				status === "succeeded"
					? "Your auto-reload top-up went through."
					: "We’ll credit your wallet once it settles.",
		});
	}

	// No client secret → we can't drive the confirmation; point at a manual top-up.
	if (!clientSecret) {
		return (
			<Alert data-hosted="true" variant={variant}>
				<AlertCircle />
				<AlertTitle>{title}</AlertTitle>
				<AlertDescription className="flex flex-col items-start gap-3">
					<span>
						{declined
							? "Update your card or top up manually. Auto-reload pauses after repeated declines; managed AI and wallet-funded compute still use the remaining balance."
							: "Your bank is still confirming the last auto-reload. Managed AI and wallet-funded compute still use the remaining balance until it clears."}
					</span>
					{onTopUp ? (
						<Button size="sm" onClick={onTopUp}>
							<CreditCard /> Top up manually
						</Button>
					) : null}
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<Alert data-hosted="true" variant={variant}>
			<AlertCircle />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span>
					{declined
						? "Your saved card was declined. Retry with a card to complete this top-up before the remaining balance runs out."
						: "Your bank asked to confirm this top-up. Complete it here before the remaining balance runs out."}
				</span>
				{confirming ? (
					<div className="w-full">
						<StripePaymentForm
							clientSecret={clientSecret}
							onComplete={onComplete}
							onCancel={() => setConfirming(false)}
						/>
					</div>
				) : (
					<Button size="sm" onClick={() => setConfirming(true)}>
						{declined ? (
							<>
								<RefreshCw /> Retry payment
							</>
						) : (
							<>
								<CreditCard /> Confirm payment
							</>
						)}
					</Button>
				)}
			</AlertDescription>
		</Alert>
	);
}
