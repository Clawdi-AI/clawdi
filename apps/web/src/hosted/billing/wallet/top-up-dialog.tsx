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
import { isIdempotencyKeyReusedError, normalizeBillingError } from "@/hosted/billing/errors";
import { formatCents } from "@/hosted/billing/format";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import { useSensitiveTopUp } from "@/hosted/billing/sensitive-actions";
import type { PaymentIntentClientSecret } from "@/hosted/billing/stripe-client-secret";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import {
	type PaymentOutcome,
	StripePaymentForm,
} from "@/hosted/billing/wallet/stripe-payment-form";
import {
	completeTopup,
	handleTopupStartResult,
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

type Step = "amount" | "pay";

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
	onComplete?: (status: "succeeded" | "processing", paymentReference: string | null) => void;
	initialAmountCents?: number | null;
}) {
	const topUp = useSensitiveTopUp();
	const qc = useQueryClient();
	const runAction = useActionLock();
	const [step, setStep] = useState<Step>("amount");
	const [dollars, setDollars] = useState(String(TOPUP_DEFAULT_CENTS / 100));
	const [clientSecret, setClientSecret] = useState<PaymentIntentClientSecret | null>(null);
	const [amountTouched, setAmountTouched] = useState(false);
	const [paymentSubmitting, setPaymentSubmitting] = useState(false);
	useSettingsEditState({ dirty: false, busy: open && (topUp.isPending || paymentSubmitting) });
	// One idempotency key per top-up ATTEMPT, reused across a retry of the same
	// amount so a timeout-resubmit / double-tab can't create two PaymentIntents.
	// Reset whenever the amount changes (a genuinely new attempt) or the flow
	// closes.
	const topupKeyRef = useRef<string | null>(null);
	const paymentReferenceRef = useRef<string | null>(null);

	const amountCents = Number(dollars) * 100;
	const valid = validTopUpAmountCents(amountCents);
	const amountInvalid = amountTouched && !valid;
	function finishTopup(status: PaymentOutcome) {
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
		setStep("amount");
		setClientSecret(null);
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
			handleTopupStartResult(result, {
				queryClient: qc,
				resetAttempt: () => {
					topupKeyRef.current = null;
				},
				// Successful completion is not a dismiss attempt. Close directly so the
				// in-flight guard cannot leave a completed payment flow stranded open.
				closeDialog: () => {
					onOpenChange(false);
				},
				toastInfo: toast.info,
				toastError: toast.error,
				onComplete: finishTopup,
				startPayment: (nextClientSecret) => {
					setClientSecret(nextClientSecret);
					setStep("pay");
				},
			});
		} catch (e) {
			const reused = isIdempotencyKeyReusedError(e);
			if (reused) topupKeyRef.current = null;
			toast.error(reused ? "Start a fresh top-up" : "Couldn’t start top-up", {
				description: normalizeBillingError(e),
			});
		}
	}

	// Only terminal outcomes reach here — `requires_action` (3DS) is completed
	// inline by StripePaymentForm, which keeps the payment flow open until it settles
	// rather than closing on an unconfirmed payment.
	function onPaid(status: PaymentOutcome) {
		setPaymentSubmitting(false);
		completeTopup(status === "succeeded" ? "succeeded" : "processing", {
			queryClient: qc,
			resetAttempt: () => {
				topupKeyRef.current = null;
			},
			closeDialog: () => onOpenChange(false),
			toastInfo: toast.info,
			onComplete: finishTopup,
		});
	}

	const description =
		step === "amount"
			? `Add a whole-dollar amount from ${TOPUP_AMOUNT_RANGE_LABEL} to your Wallet.`
			: `Choose a payment method to pay ${formatCents(amountCents)}.`;
	const content =
		step === "amount" ? (
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
						className={amountInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
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
		) : clientSecret ? (
			<StripePaymentForm
				clientSecret={clientSecret}
				onComplete={onPaid}
				onCancel={() => {
					setClientSecret(null);
					setStep("amount");
				}}
				summary={`Top-up charge: ${formatCents(amountCents)}`}
				submitLabel={`Pay ${formatCents(amountCents)}`}
				onSubmittingChange={setPaymentSubmitting}
			/>
		) : null;

	return (
		<Dialog
			open={open}
			onOpenChange={close}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) reset();
			}}
		>
			<DialogContent
				className="sm:max-w-md"
				data-hosted="true"
				showCloseButton={!topUp.isPending && !paymentSubmitting}
			>
				<DialogHeader>
					<DialogTitle>Top up Wallet</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{content}
			</DialogContent>
		</Dialog>
	);
}
