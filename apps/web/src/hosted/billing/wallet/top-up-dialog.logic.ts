import type { QueryClient } from "@tanstack/react-query";
import type { WalletLedgerEntry, WalletTopupResult } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	type PaymentIntentClientSecret,
	walletTopupPaymentIntentClientSecret,
} from "@/hosted/billing/stripe-client-secret";
import { WALLET_TOPUP_ACCEPTED_TOAST } from "@/hosted/billing/wallet/top-up-return.logic";
import {
	TOPUP_INCREMENT_CENTS,
	TOPUP_MAX_CENTS,
	TOPUP_MIN_CENTS,
} from "@/hosted/billing/wallet/wallet-constants";

type TopupToast = (message: string, options: { description: string }) => void;
const TOP_UP_CREDIT_RECHECK_INTERVAL_MS = 3_000;
const TOP_UP_CREDIT_RECHECK_LIMIT = 10;

export type TopupCompletionStatus = "succeeded" | "processing";

export interface TopupCompletionControls {
	queryClient: QueryClient;
	resetAttempt: () => void;
	closeDialog: () => void;
	toastInfo: TopupToast;
	onComplete?: (status: TopupCompletionStatus) => void;
}

export interface TopupStartResultControls extends TopupCompletionControls {
	startPayment: (clientSecret: PaymentIntentClientSecret) => void;
	toastError: TopupToast;
}

export function validTopUpAmountCents(amountCents: number): boolean {
	return (
		Number.isFinite(amountCents) &&
		amountCents >= TOPUP_MIN_CENTS &&
		amountCents <= TOPUP_MAX_CENTS &&
		amountCents % TOPUP_INCREMENT_CENTS === 0
	);
}

/** Convert a USD shortfall into the smallest whole-dollar top-up that covers it. */
export function topUpAmountCentsForUsdShortfall(shortfallUsd: number | null): number | null {
	if (shortfallUsd === null || !Number.isFinite(shortfallUsd) || shortfallUsd <= 0) {
		return null;
	}
	const rawCents = shortfallUsd * 100;
	const roundedCents = Math.ceil(rawCents / TOPUP_INCREMENT_CENTS) * TOPUP_INCREMENT_CENTS;
	return Math.min(TOPUP_MAX_CENTS, Math.max(TOPUP_MIN_CENTS, roundedCents));
}

export function invalidateWalletActivity(queryClient: QueryClient): void {
	queryClient.invalidateQueries({ queryKey: billingKeys.wallet });
	queryClient.invalidateQueries({ queryKey: billingKeys.ledgerRoot });
	queryClient.invalidateQueries({ queryKey: billingKeys.subscriptionCreateQuotes });
	queryClient.invalidateQueries({ queryKey: billingKeys.deployments });
	queryClient.invalidateQueries({ queryKey: billingKeys.billingHistoryRoot });
	queryClient.invalidateQueries({ queryKey: ["get", "/v1/agents"] });
}

export function completeTopup(
	status: TopupCompletionStatus,
	controls: TopupCompletionControls,
): void {
	invalidateWalletActivity(controls.queryClient);
	controls.resetAttempt();
	controls.onComplete?.(status);
	if (status === "succeeded") {
		controls.toastInfo(WALLET_TOPUP_ACCEPTED_TOAST.title, {
			description: WALLET_TOPUP_ACCEPTED_TOAST.description,
		});
	} else {
		controls.toastInfo("Payment processing", {
			description: "We'll credit your wallet once the payment settles.",
		});
	}
	controls.closeDialog();
}

export function walletTopupCreditIsApplied(
	paymentReference: string | null,
	entries: readonly WalletLedgerEntry[],
): boolean {
	if (!paymentReference) return false;
	return entries.some(
		(entry) =>
			entry.operation === "topup" &&
			entry.status === "applied" &&
			entry.payment_reference === paymentReference,
	);
}

export async function waitForWalletTopupCredit(
	queryClient: QueryClient,
	paymentReference: string,
): Promise<boolean> {
	for (let attempt = 0; attempt < TOP_UP_CREDIT_RECHECK_LIMIT; attempt += 1) {
		const refreshes = await Promise.allSettled([
			queryClient.refetchQueries(
				{ queryKey: billingKeys.wallet, type: "active" },
				{ throwOnError: true },
			),
			queryClient.refetchQueries(
				{ queryKey: billingKeys.ledgerRoot, type: "active" },
				{ throwOnError: true },
			),
		]);
		const ledgerPages = queryClient.getQueriesData<{ items: WalletLedgerEntry[] }>({
			queryKey: billingKeys.ledgerRoot,
		});
		if (
			refreshes.every((refresh) => refresh.status === "fulfilled") &&
			ledgerPages.some(([, page]) =>
				walletTopupCreditIsApplied(paymentReference, page?.items ?? []),
			)
		) {
			return true;
		}
		if (attempt + 1 < TOP_UP_CREDIT_RECHECK_LIMIT) {
			await new Promise<void>((resolve) =>
				globalThis.setTimeout(resolve, TOP_UP_CREDIT_RECHECK_INTERVAL_MS),
			);
		}
	}
	return false;
}

export function handleTopupStartResult(
	result: WalletTopupResult,
	controls: TopupStartResultControls,
): void {
	// Only the PaymentIntent status decides success. A quoted amount can also
	// appear on an incomplete response, so it must not close the payment step.
	if (result.status === "succeeded") {
		completeTopup("succeeded", controls);
		return;
	}
	const clientSecret = walletTopupPaymentIntentClientSecret(result);
	if (clientSecret) {
		// A pending ledger row matters only on a mounted activity surface. Keep
		// balance and the rest of wallet activity untouched until payment settles.
		void controls.queryClient.refetchQueries({
			queryKey: billingKeys.ledgerRoot,
			type: "active",
		});
		controls.startPayment(clientSecret);
		return;
	}
	if (isProcessingTopupStatus(result.status)) {
		completeTopup("processing", controls);
		return;
	}
	controls.toastError("Couldn't start top-up", {
		description: "No payment was returned. Please try again.",
	});
}

function isProcessingTopupStatus(status: string): boolean {
	return status === "processing" || status === "pending" || status === "requires_capture";
}
