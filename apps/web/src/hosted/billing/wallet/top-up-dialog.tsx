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
import type { WalletState } from "@/hosted/billing/contracts";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { formatCents, formatCredits } from "@/hosted/billing/format";
import { useTopUp } from "@/hosted/billing/hooks";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import {
	type PaymentOutcome,
	StripePaymentForm,
} from "@/hosted/billing/wallet/stripe-payment-form";
import { completeTopup, handleTopupStartResult } from "@/hosted/billing/wallet/top-up-dialog.logic";
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
	wallet,
	onComplete,
	initialAmountCents,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	wallet: WalletState;
	onComplete?: (status: "succeeded" | "processing") => void;
	initialAmountCents?: number | null;
}) {
	const topUp = useTopUp();
	const qc = useQueryClient();
	const runAction = useActionLock();
	const [step, setStep] = useState<Step>("amount");
	const [dollars, setDollars] = useState(String(TOPUP_DEFAULT_CENTS / 100));
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	// One idempotency key per top-up ATTEMPT, reused across a retry of the same
	// amount so a timeout-resubmit / double-tab can't create two PaymentIntents.
	// Reset whenever the amount changes (a genuinely new attempt) or the dialog
	// closes.
	const topupKeyRef = useRef<string | null>(null);

	const amountCents = Math.round(Number(dollars) * 100);
	const valid =
		Number.isFinite(amountCents) &&
		amountCents >= TOPUP_MIN_CENTS &&
		amountCents <= TOPUP_MAX_CENTS;
	const amountInvalid = !valid && Boolean(dollars);
	const credits = valid ? formatCredits((amountCents / 100) * wallet.points_per_usd) : "";

	function setAmount(next: string) {
		setDollars(next);
		// New amount = new attempt; mint a fresh key on the next Continue.
		topupKeyRef.current = null;
	}

	function reset() {
		setStep("amount");
		setClientSecret(null);
		topupKeyRef.current = null;
	}

	function close(next: boolean) {
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
				closeDialog: () => close(false),
				toastSuccess: toast.success,
				toastError: toast.error,
				onComplete,
				startPayment: (nextClientSecret) => {
					setClientSecret(nextClientSecret);
					setStep("pay");
				},
			});
		} catch (e) {
			toast.error("Couldn’t start top-up", { description: normalizeBillingError(e) });
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
			closeDialog: () => close(false),
			toastSuccess: toast.success,
			onComplete,
		});
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-md" data-hosted="true">
				<DialogHeader>
					<DialogTitle>Top up AI Credits</DialogTitle>
					<DialogDescription>
						{step === "amount"
							? `Add between ${formatCents(TOPUP_MIN_CENTS)} and ${formatCents(TOPUP_MAX_CENTS)}. $1 = ${wallet.points_per_usd.toLocaleString()} credits.`
							: "Enter your card details to complete the top-up."}
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
									aria-invalid={amountInvalid}
									aria-describedby={amountInvalid ? "topup-amount-err" : undefined}
								/>
							</div>
							{amountInvalid ? (
								<p id="topup-amount-err" className="text-xs text-destructive">
									Enter an amount between {formatCents(TOPUP_MIN_CENTS)} and{" "}
									{formatCents(TOPUP_MAX_CENTS)}.
								</p>
							) : credits ? (
								<p className="text-xs text-muted-foreground">You’ll get {credits}.</p>
							) : null}
						</div>
						<div className="flex justify-end">
							<Button onClick={() => runAction(onContinue)} disabled={!valid || topUp.isPending}>
								{topUp.isPending ? (
									<>
										<Spinner /> Starting…
									</>
								) : (
									"Continue"
								)}
							</Button>
						</div>
					</div>
				) : clientSecret ? (
					<StripePaymentForm
						clientSecret={clientSecret}
						onComplete={onPaid}
						onCancel={() => setStep("amount")}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
