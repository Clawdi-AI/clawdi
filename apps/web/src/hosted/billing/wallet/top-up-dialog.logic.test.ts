import { describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { WalletTopupResult } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	handleTopupStartResult,
	topUpAmountCentsForCreditShortfall,
} from "@/hosted/billing/wallet/top-up-dialog.logic";

function result(overrides: Partial<WalletTopupResult>): WalletTopupResult {
	return {
		status: "requires_payment_method",
		flow_type: null,
		payment_intent_id: null,
		client_secret: null,
		credits_added: null,
		...overrides,
	};
}

function queryClientWithWalletActivity(): QueryClient {
	const qc = new QueryClient();
	qc.setQueryData(billingKeys.wallet, { balance_cents: 1_000 });
	qc.setQueryData(billingKeys.ledger(50), { items: [] });
	return qc;
}

describe("handleTopupStartResult", () => {
	test("treats synchronous success as terminal success and refreshes wallet activity", () => {
		const qc = queryClientWithWalletActivity();
		const resetAttempt = mock(() => {});
		const closeDialog = mock(() => {});
		const startPayment = mock((_clientSecret: string) => {});
		const toastSuccess = mock((_message: string, _options: { description: string }) => {});
		const toastError = mock((_message: string, _options: { description: string }) => {});

		handleTopupStartResult(
			result({
				status: "succeeded",
				flow_type: "mock",
				client_secret: null,
				credits_added: 2500,
			}),
			{
				queryClient: qc,
				resetAttempt,
				closeDialog,
				startPayment,
				toastSuccess,
				toastError,
			},
		);

		expect(qc.getQueryState(billingKeys.wallet)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(billingKeys.ledger(50))?.isInvalidated).toBe(true);
		expect(resetAttempt).toHaveBeenCalledTimes(1);
		expect(closeDialog).toHaveBeenCalledTimes(1);
		expect(toastSuccess).toHaveBeenCalledWith("Top-up complete", {
			description: "Your credits will appear in a moment.",
		});
		expect(toastError).not.toHaveBeenCalled();
		expect(startPayment).not.toHaveBeenCalled();
	});

	test("keeps payment intent responses on the card payment step", () => {
		const qc = queryClientWithWalletActivity();
		const resetAttempt = mock(() => {});
		const closeDialog = mock(() => {});
		const startPayment = mock((_clientSecret: string) => {});
		const toastSuccess = mock((_message: string, _options: { description: string }) => {});
		const toastError = mock((_message: string, _options: { description: string }) => {});

		handleTopupStartResult(
			result({
				status: "requires_payment_method",
				flow_type: "payment_intent",
				payment_intent_id: "pi_123",
				client_secret: "pi_123_secret_456",
				// The real backend response ALWAYS carries credits_added (the
				// credits this top-up will add once paid). Regression guard: this
				// used to be misread as "already succeeded", closing the dialog
				// before the card form ever showed.
				credits_added: 25_000,
			}),
			{
				queryClient: qc,
				resetAttempt,
				closeDialog,
				startPayment,
				toastSuccess,
				toastError,
			},
		);

		expect(startPayment).toHaveBeenCalledWith("pi_123_secret_456");
		expect(closeDialog).not.toHaveBeenCalled();
		expect(resetAttempt).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});
});

describe("topUpAmountCentsForCreditShortfall", () => {
	test("rounds up to whole dollars and clamps to the allowed top-up range", () => {
		expect(topUpAmountCentsForCreditShortfall(4_000, 1_000)).toBe(1_000);
		expect(topUpAmountCentsForCreditShortfall(14_000, 1_000)).toBe(1_400);
		expect(topUpAmountCentsForCreditShortfall(25_001, 1_000)).toBe(2_600);
		expect(topUpAmountCentsForCreditShortfall(2_500_000, 1_000)).toBe(200_000);
	});

	test("ignores missing or invalid conversion inputs", () => {
		expect(topUpAmountCentsForCreditShortfall(null, 1_000)).toBeNull();
		expect(topUpAmountCentsForCreditShortfall(14_000, 0)).toBeNull();
		expect(topUpAmountCentsForCreditShortfall(Number.NaN, 1_000)).toBeNull();
	});
});
