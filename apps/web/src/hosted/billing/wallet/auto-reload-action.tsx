"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CreditCard, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useSettingsEditState } from "@/components/settings-edit-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { WalletState } from "@/hosted/billing/contracts";
import { formatCents } from "@/hosted/billing/format";
import { billingKeys } from "@/hosted/billing/query-keys";
import { useSensitiveWalletSnapshot } from "@/hosted/billing/sensitive-actions";
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
	initialClientSecret,
	onDiscardClientSecret,
}: {
	wallet: WalletState;
	onTopUp?: () => void;
	initialClientSecret?: string | null;
	onDiscardClientSecret?: () => void;
}) {
	const qc = useQueryClient();
	const walletSnapshot = useSensitiveWalletSnapshot();
	const [confirming, setConfirming] = useState(false);
	const [paymentSubmitting, setPaymentSubmitting] = useState(false);
	const [clientSecret, setClientSecret] = useState<string | null>(
		() => initialClientSecret ?? null,
	);
	const [secretUnavailable, setSecretUnavailable] = useState(false);
	useSettingsEditState({
		dirty: false,
		busy: walletSnapshot.isPending || (confirming && paymentSubmitting),
	});

	const action = wallet.auto_reload_action;
	useEffect(() => {
		if (initialClientSecret) {
			setClientSecret(initialClientSecret);
			setSecretUnavailable(false);
		}
	}, [initialClientSecret]);

	useEffect(() => {
		if (!action) {
			setClientSecret(null);
			setConfirming(false);
			setSecretUnavailable(false);
		}
	}, [action]);

	if (!action) return null;
	const actionAttemptId = action.attempt_id;

	const declined = action.error_code != null;
	const variant = declined ? "destructive" : "default";
	const title = declined ? "Last auto-reload was declined" : "Confirm your last auto-reload";
	const charge = formatCents(wallet.auto_reload_amount_cents);

	function onComplete(status: PaymentOutcome) {
		// The wallet snapshot resolves `auto_reload_action` once the PaymentIntent
		// settles; refetch balance + activity so this control clears itself.
		qc.invalidateQueries({ queryKey: billingKeys.wallet });
		qc.invalidateQueries({ queryKey: billingKeys.ledgerRoot });
		setPaymentSubmitting(false);
		setConfirming(false);
		setClientSecret(null);
		onDiscardClientSecret?.();
		toast.success(status === "succeeded" ? "Payment confirmed" : "Payment processing", {
			description:
				status === "succeeded"
					? "Your auto-reload top-up went through."
					: "We’ll credit your wallet once it settles.",
		});
	}

	function cancelConfirmation() {
		setPaymentSubmitting(false);
		setConfirming(false);
		setClientSecret(null);
		onDiscardClientSecret?.();
	}

	async function beginConfirmation() {
		if (walletSnapshot.isPending) return;
		if (clientSecret) {
			setConfirming(true);
			return;
		}
		try {
			const latest = await walletSnapshot.execute();
			const latestAction = latest.auto_reload_action;
			const secret =
				latestAction?.attempt_id === actionAttemptId ? latestAction.client_secret : null;
			if (!secret) {
				setSecretUnavailable(true);
				toast.error("Payment confirmation unavailable", {
					description: "Top up manually or refresh the Wallet and try again.",
				});
				return;
			}
			setClientSecret(secret);
			setSecretUnavailable(false);
			setConfirming(true);
		} catch {
			toast.error("Couldn’t load payment confirmation", {
				description: "Check your connection and try again.",
			});
		}
	}

	// No client secret → we can't drive the confirmation; point at a manual top-up.
	if (secretUnavailable) {
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
						<Button type="button" size="sm" onClick={onTopUp}>
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
						? `Your saved card was declined. Retry the ${charge} top-up before the remaining balance runs out.`
						: `Your bank asked to confirm this ${charge} top-up. Complete it before the remaining balance runs out.`}
				</span>
				{confirming && clientSecret ? (
					<div className="w-full">
						<StripePaymentForm
							clientSecret={clientSecret}
							onComplete={onComplete}
							onCancel={cancelConfirmation}
							summary={`Auto-reload charge: ${charge}`}
							submitLabel={`${declined ? "Retry" : "Confirm"} ${charge} payment`}
							onSubmittingChange={setPaymentSubmitting}
						/>
					</div>
				) : (
					<Button
						type="button"
						size="sm"
						onClick={() => void beginConfirmation()}
						disabled={walletSnapshot.isPending}
					>
						{walletSnapshot.isPending ? (
							<>Loading payment…</>
						) : declined ? (
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
