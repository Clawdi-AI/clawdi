"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { useTopUp } from "@/hosted/billing/hooks";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import {
	type PaymentOutcome,
	StripePaymentForm,
} from "@/hosted/billing/wallet/stripe-payment-form";
import {
	completeTopup,
	handleTopupStartResult,
	validTopUpAmountCents,
} from "@/hosted/billing/wallet/top-up-dialog.logic";
import {
	TOPUP_DEFAULT_CENTS,
	TOPUP_INCREMENT_CENTS,
	TOPUP_MAX_CENTS,
	TOPUP_MIN_CENTS,
	TOPUP_PRESETS_CENTS,
} from "@/hosted/billing/wallet/wallet-constants";

type Step = "amount" | "pay";

export function TopUpDialog({
	open,
	onOpenChange,
	onComplete,
	initialAmountCents,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onComplete?: (status: "succeeded" | "processing") => void;
	initialAmountCents?: number | null;
}) {
	const topUp = useTopUp();
	const qc = useQueryClient();
	const runAction = useActionLock();
	const [step, setStep] = useState<Step>("amount");
	const [dollars, setDollars] = useState(String(TOPUP_DEFAULT_CENTS / 100));
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [amountTouched, setAmountTouched] = useState(false);
	const [paymentSubmitting, setPaymentSubmitting] = useState(false);
	// One idempotency key per top-up ATTEMPT, reused across a retry of the same
	// amount so a timeout-resubmit / double-tab can't create two PaymentIntents.
	// Reset whenever the amount changes (a genuinely new attempt) or the dialog
	// closes.
	const topupKeyRef = useRef<string | null>(null);

	const amountCents = Number(dollars) * 100;
	const valid = validTopUpAmountCents(amountCents);
	const amountInvalid = amountTouched && !valid;

	function setAmount(next: string) {
		setDollars(next);
		setAmountTouched(false);
		// New amount = new attempt; mint a fresh key on the next Continue.
		topupKeyRef.current = null;
	}

	function reset() {
		setStep("amount");
		setClientSecret(null);
		setAmountTouched(false);
		setPaymentSubmitting(false);
		topupKeyRef.current = null;
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
			const result = await topUp.mutateAsync({
				body: { amount_cents: amountCents },
				idempotencyKey: topupKeyRef.current,
			});
			handleTopupStartResult(result, {
				queryClient: qc,
				resetAttempt: () => {
					topupKeyRef.current = null;
				},
				// Successful completion is not a dismiss attempt. Close directly so the
				// in-flight guard cannot leave a completed payment dialog stranded open.
				closeDialog: () => onOpenChange(false),
				toastSuccess: toast.success,
				toastError: toast.error,
				onComplete,
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
	// inline by StripePaymentForm, which keeps the dialog open until it settles
	// rather than closing on an unconfirmed payment.
	function onPaid(status: PaymentOutcome) {
		completeTopup(status === "succeeded" ? "succeeded" : "processing", {
			queryClient: qc,
			resetAttempt: () => {
				topupKeyRef.current = null;
			},
			closeDialog: () => onOpenChange(false),
			toastSuccess: toast.success,
			onComplete,
		});
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent
				className="sm:max-w-md"
				data-hosted="true"
				showCloseButton={!topUp.isPending && !paymentSubmitting}
			>
				<DialogHeader>
					<DialogTitle>Top up Wallet</DialogTitle>
					<DialogDescription>
						{step === "amount"
							? `Add between ${formatCents(TOPUP_MIN_CENTS)} and ${formatCents(TOPUP_MAX_CENTS)} to your Wallet.`
							: `Enter your card details to pay ${formatCents(amountCents)}.`}
					</DialogDescription>
				</DialogHeader>

				{step === "amount" ? (
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
								{amountInvalid
									? `Enter a whole-dollar amount from ${formatCents(TOPUP_MIN_CENTS)} to ${formatCents(TOPUP_MAX_CENTS)}.`
									: valid
										? `You’ll add ${formatCents(amountCents)} to your Wallet. Whole-dollar amounts only.`
										: `Enter a whole-dollar amount from ${formatCents(TOPUP_MIN_CENTS)} to ${formatCents(TOPUP_MAX_CENTS)}.`}
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
						onCancel={() => setStep("amount")}
						summary={`Top-up charge: ${formatCents(amountCents)}`}
						submitLabel={`Pay ${formatCents(amountCents)}`}
						onSubmittingChange={setPaymentSubmitting}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
