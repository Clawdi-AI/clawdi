"use client";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettingsEditState } from "@/components/settings-edit-state";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useBillingClient } from "@/hosted/billing/billing-client";
import { StripeCheckoutDialog } from "@/hosted/billing/components/stripe-checkout-dialog";
import type { WalletTopupResult } from "@/hosted/billing/contracts";
import { isIdempotencyKeyReusedError, normalizeBillingError } from "@/hosted/billing/errors";
import { formatCents, usdInputToCents } from "@/hosted/billing/format";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import { useSensitiveTopUp } from "@/hosted/billing/sensitive-actions";
import { walletTopupCheckoutClientSecret } from "@/hosted/billing/stripe-client-secret";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import {
	completeTopup,
	invalidateWalletData,
	type TopupCompletionStatus,
	validTopUpAmountCents,
	waitForWalletTopupCredit,
} from "@/hosted/billing/wallet/top-up-dialog.logic";
import {
	TOPUP_AMOUNT_RANGE_LABEL,
	TOPUP_DEFAULT_CENTS,
	TOPUP_INCREMENT_CENTS,
	TOPUP_MAX_CENTS,
	TOPUP_MIN_CENTS,
	TOPUP_PRESETS_CENTS,
} from "@/hosted/billing/wallet/wallet-constants";

export async function confirmWalletTopup(
	queryClient: QueryClient,
	paymentReference: string | null,
) {
	if (!paymentReference) {
		toast.warning("Wallet credit can’t be confirmed automatically", {
			description:
				"The payment did not include a link to Wallet Transactions. The balance and Transactions may take a moment to update.",
		});
		return;
	}
	if (await waitForWalletTopupCredit(queryClient, paymentReference)) {
		toast.success("Wallet credited", {
			description: "Your balance and Transactions now include the top-up.",
		});
		return;
	}
	toast.info("Wallet credit not confirmed yet", {
		description:
			"The Wallet has not linked this payment to the displayed balance and Transactions yet.",
		action: {
			label: "Check again",
			onClick: () => void confirmWalletTopup(queryClient, paymentReference),
		},
	});
}

export function TopUpDialog({
	open,
	onOpenChange,
	onComplete,
	initialAmountCents,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onComplete?: (status: TopupCompletionStatus, paymentReference: string | null) => void;
	initialAmountCents?: number | null;
}) {
	const topUp = useSensitiveTopUp();
	const billing = useBillingClient();
	const [checkout, setCheckout] = useState<WalletTopupResult | null>(null);
	const checkoutSecret = checkout ? walletTopupCheckoutClientSecret(checkout) : null;
	const qc = useQueryClient();
	const runAction = useActionLock();
	const [dollars, setDollars] = useState(String(TOPUP_DEFAULT_CENTS / 100));
	const [amountTouched, setAmountTouched] = useState(false);
	const [paymentSubmitting, setPaymentSubmitting] = useState(false);
	useSettingsEditState({ dirty: false, busy: open && (topUp.isPending || paymentSubmitting) });
	// One idempotency key per top-up ATTEMPT, reused across a retry of the same
	// amount so retries cannot create two Checkout Sessions.
	// Reset whenever the amount changes (a genuinely new attempt) or the flow
	// closes.
	const topupKeyRef = useRef<string | null>(null);
	const paymentReferenceRef = useRef<string | null>(null);

	const amountCents = usdInputToCents(dollars) ?? Number.NaN;
	const valid = validTopUpAmountCents(amountCents);
	const amountInvalid = amountTouched && !valid;
	function finishTopup(status: TopupCompletionStatus) {
		onComplete?.(status, paymentReferenceRef.current);
	}

	function setAmount(next: string) {
		setDollars(next);
		setAmountTouched(false);
		// New amount = new attempt; mint a fresh key on the next Continue.
		topupKeyRef.current = null;
		paymentReferenceRef.current = null;
	}

	function reset() {
		setCheckout(null);
		setAmountTouched(false);
		setPaymentSubmitting(false);
		topupKeyRef.current = null;
		paymentReferenceRef.current = null;
	}

	function close(next: boolean) {
		if (!next && (topUp.isPending || paymentSubmitting)) return;
		onOpenChange(next);
	}

	useEffect(() => {
		if (!open) return;
		reset();
		setDollars(String((initialAmountCents ?? TOPUP_DEFAULT_CENTS) / 100));
	}, [initialAmountCents, open]);

	async function onContinue() {
		// Guard double-submit: the button disables on pending, but a fast
		// double-click could slip a second request through before it repaints.
		if (!valid || topUp.isPending) return;
		setAmountTouched(true);
		topupKeyRef.current ??= newIdempotencyKey("topup");
		try {
			const result = await topUp.execute({
				body: { amount_cents: amountCents },
				idempotencyKey: topupKeyRef.current,
			});
			paymentReferenceRef.current = result.payment_intent_id ?? null;
			if (walletTopupCheckoutClientSecret(result) && result.checkout_session_id) {
				setCheckout(result);
				return;
			}
			if (result.status === "succeeded" || result.status === "processing") {
				onPaid(result.status);
				return;
			}
			if (result.status === "expired") {
				topupKeyRef.current = null;
				toast.error("This checkout expired. Start a fresh top-up.");
				return;
			}
			toast.error("Couldn't start top-up", {
				description: "Refresh Wallet to check this payment before starting another top-up.",
			});
		} catch (e) {
			const reused = isIdempotencyKeyReusedError(e);
			if (reused) topupKeyRef.current = null;
			toast.error(reused ? "Start a fresh top-up" : "Couldn’t start top-up", {
				description: normalizeBillingError(e),
			});
		}
	}

	function onPaid(status: TopupCompletionStatus) {
		setPaymentSubmitting(false);
		completeTopup(status, {
			queryClient: qc,
			resetAttempt: () => {
				topupKeyRef.current = null;
			},
			closeDialog: () => onOpenChange(false),
			toastInfo: toast.info,
			onComplete: finishTopup,
		});
	}

	async function onCheckoutPaid() {
		const checkoutId = checkout?.checkout_session_id;
		if (!checkoutId) return;
		try {
			const result = await billing.getWalletTopupCheckout(checkoutId);
			paymentReferenceRef.current = result.payment_intent_id ?? null;
			if (result.status !== "succeeded" && result.status !== "processing") {
				setPaymentSubmitting(false);
				invalidateWalletData(qc);
				toast.error("Top-up payment didn't finish", {
					description: "Review your payment method and try again.",
				});
				onOpenChange(false);
				return;
			}
			onPaid(result.status);
		} catch {
			// Confirmation already succeeded; a refresh failure must never invite a second charge.
			onPaid("processing");
		}
	}

	if (checkoutSecret)
		return (
			<StripeCheckoutDialog
				open={open}
				clientSecret={checkoutSecret}
				title="Top up Wallet"
				description={`Choose a payment method to pay ${formatCents(amountCents)}.`}
				summary={null}
				submitLabel={`Pay ${formatCents(amountCents)}`}
				onSubmittingChange={setPaymentSubmitting}
				onOpenChange={close}
				onExpired={() => {
					reset();
					toast.error("This checkout expired. Start a fresh top-up.");
				}}
				onComplete={() => void onCheckoutPaid()}
			/>
		);

	return (
		<Dialog
			open={open}
			onOpenChange={close}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) reset();
			}}
		>
			<DialogContent
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
				data-hosted="true"
				showCloseButton={!topUp.isPending && !paymentSubmitting}
			>
				<DialogHeader>
					<DialogTitle>Top up Wallet</DialogTitle>
					<DialogDescription>
						Add a whole-dollar amount from {TOPUP_AMOUNT_RANGE_LABEL} to your Wallet.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="flex flex-wrap gap-2">
						{TOPUP_PRESETS_CENTS.map((preset) => (
							<Button
								key={preset}
								type="button"
								size="sm"
								variant={amountCents === preset ? "default" : "outline"}
								aria-pressed={amountCents === preset}
								onClick={() => setAmount(String(preset / 100))}
							>
								{formatCents(preset)}
							</Button>
						))}
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="topup-amount">Amount (USD)</Label>
						<div className="relative">
							<span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
								$
							</span>
							<Input
								id="topup-amount"
								name="topup-amount"
								type="number"
								inputMode="decimal"
								autoComplete="off"
								min={TOPUP_MIN_CENTS / 100}
								max={TOPUP_MAX_CENTS / 100}
								step={TOPUP_INCREMENT_CENTS / 100}
								className="pl-6"
								value={dollars}
								onChange={(e) => setAmount(e.target.value)}
								onBlur={() => setAmountTouched(true)}
								aria-invalid={amountInvalid}
								aria-describedby="topup-amount-help"
							/>
						</div>
						<p
							id="topup-amount-help"
							className={
								amountInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"
							}
							aria-live="polite"
						>
							{valid
								? `You’ll add ${formatCents(amountCents)} to your Wallet. Whole-dollar amounts only.`
								: `Enter a whole-dollar amount from ${TOPUP_AMOUNT_RANGE_LABEL}.`}
						</p>
					</div>
					<div className="flex justify-end">
						<Button onClick={() => runAction(onContinue)} disabled={!valid || topUp.isPending}>
							{topUp.isPending ? (
								<>
									<Spinner /> Starting…
								</>
							) : (
								`Continue with ${formatCents(amountCents)}`
							)}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
