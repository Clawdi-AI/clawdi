import { describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { WalletTransaction } from "@/hosted/billing/contracts";
import { usdInputToCents } from "@/hosted/billing/format";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	completeTopup,
	topUpAmountCentsForUsdShortfall,
	validTopUpAmountCents,
	waitForWalletTopupCredit,
	walletTopupCreditIsApplied,
} from "@/hosted/billing/wallet/top-up-dialog.logic";

function queryClientWithWalletData(): QueryClient {
	const qc = new QueryClient();
	qc.setQueryData(billingKeys.wallet, { balance_cents: 1_000 });
	qc.setQueryData(billingKeys.transactions, { pages: [{ items: [] }], pageParams: [null] });
	qc.setQueryData(billingKeys.subscriptionCreateQuote("compute_basic", 1, "wallet"), {
		term_price_cents: 1_500,
	});
	qc.setQueryData(billingKeys.deployments, []);
	qc.setQueryData(billingKeys.subscriptions, { pages: [], pageParams: [] });
	qc.setQueryData(["get", "/v1/agents"], []);
	return qc;
}

function setupControls(queryClient: QueryClient) {
	const resetAttempt = mock(() => {});
	const closeDialog = mock(() => {});
	const toastInfo = mock((_message: string, _options: { description: string }) => {});
	const onComplete = mock((_status: "succeeded" | "processing") => {});
	return {
		queryClient,
		resetAttempt,
		closeDialog,
		toastInfo,
		onComplete,
	};
}

describe("completeTopup", () => {
	test("treats synchronous success as terminal success and refreshes wallet activity", () => {
		const qc = queryClientWithWalletData();
		const setup = setupControls(qc);

		completeTopup("succeeded", setup);

		expect(qc.getQueryState(billingKeys.wallet)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(billingKeys.transactions)?.isInvalidated).toBe(true);
		expect(
			qc.getQueryState(billingKeys.subscriptionCreateQuote("compute_basic", 1, "wallet"))
				?.isInvalidated,
		).toBe(true);
		expect(qc.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(billingKeys.subscriptions)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["get", "/v1/agents"])?.isInvalidated).toBe(true);
		expect(setup.resetAttempt).toHaveBeenCalledTimes(1);
		expect(setup.closeDialog).toHaveBeenCalledTimes(1);
		expect(setup.toastInfo).toHaveBeenCalledWith("Payment accepted", {
			description: "We're confirming your Wallet credit now.",
		});
		expect(setup.onComplete).toHaveBeenCalledWith("succeeded");
	});
});

describe("walletTopupCreditIsApplied", () => {
	const transaction: WalletTransaction = {
		id: "wallet:topup",
		kind: "topup",
		occurred_at: "2026-07-27T12:00:00Z",
		amount: "25.00",
		currency: "usd",
		direction: "credit",
		status: "applied",
		funding: "card",
		payment_reference: "pi_previous",
		receipt_url: null,
	};

	test("confirms only the exact applied top-up payment reference", () => {
		expect(walletTopupCreditIsApplied("pi_current", [transaction])).toBe(false);
		expect(walletTopupCreditIsApplied(null, [{ ...transaction, payment_reference: null }])).toBe(
			false,
		);
		expect(
			walletTopupCreditIsApplied("pi_current", [
				{ ...transaction, payment_reference: "pi_current", status: "pending" },
			]),
		).toBe(false);
		expect(
			walletTopupCreditIsApplied("pi_current", [
				{ ...transaction, payment_reference: "pi_current", kind: "x402" },
			]),
		).toBe(false);
		expect(
			walletTopupCreditIsApplied("pi_current", [
				{ ...transaction, payment_reference: "pi_current", direction: "debit" },
			]),
		).toBe(false);
		expect(
			walletTopupCreditIsApplied("pi_current", [
				{ ...transaction, payment_reference: "pi_current" },
			]),
		).toBe(true);
	});

	test("reads the paginated Transactions cache used by Wallet", async () => {
		const qc = new QueryClient();
		qc.setQueryData(billingKeys.transactions, {
			pages: [{ items: [{ ...transaction, payment_reference: "pi_current" }] }],
			pageParams: [null],
		});

		expect(await waitForWalletTopupCredit(qc, "pi_current")).toBe(true);
	});
});

describe("topUpAmountCentsForUsdShortfall", () => {
	test("rounds up to whole dollars and clamps to the allowed top-up range", () => {
		expect(topUpAmountCentsForUsdShortfall("4")).toBe(1_000);
		expect(topUpAmountCentsForUsdShortfall("14")).toBe(1_400);
		expect(topUpAmountCentsForUsdShortfall("25.001")).toBe(2_600);
		expect(topUpAmountCentsForUsdShortfall("25.000000000000000001")).toBe(2_600);
		expect(topUpAmountCentsForUsdShortfall("2500")).toBe(200_000);
	});

	test("ignores missing or invalid USD inputs", () => {
		expect(topUpAmountCentsForUsdShortfall(null)).toBeNull();
		expect(topUpAmountCentsForUsdShortfall("NaN")).toBeNull();
	});
});

describe("validTopUpAmountCents", () => {
	test("enforces visible bounds and whole-dollar increments", () => {
		expect(usdInputToCents("25")).toBe(2_500);
		expect(validTopUpAmountCents(usdInputToCents("25.01") ?? Number.NaN)).toBe(false);
		for (const invalid of ["0", "-1", "01", ".50", "1.", "1.001", "1e2", " NaN", "Infinity"]) {
			expect(usdInputToCents(invalid)).toBeNull();
		}
		expect(usdInputToCents("90071992547410")).toBeNull();
		expect(validTopUpAmountCents(1_000)).toBe(true);
		expect(validTopUpAmountCents(200_000)).toBe(true);
		expect(validTopUpAmountCents(999)).toBe(false);
		expect(validTopUpAmountCents(1_001)).toBe(false);
		expect(validTopUpAmountCents(1_000.1)).toBe(false);
		expect(validTopUpAmountCents(Number.NaN)).toBe(false);
	});
});
