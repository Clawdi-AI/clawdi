import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { WalletLedgerEntry, WalletTopupResult } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	handleTopupStartResult,
	topUpAmountCentsForUsdShortfall,
	validTopUpAmountCents,
	waitForWalletTopupCredit,
	walletTopupCreditIsApplied,
} from "@/hosted/billing/wallet/top-up-dialog.logic";

function result(overrides: Partial<WalletTopupResult>): WalletTopupResult {
	return {
		status: "requires_payment_method",
		flow_type: null,
		payment_intent_id: null,
		client_secret: null,
		amount_usd: null,
		...overrides,
	};
}

function queryClientWithWalletActivity(): QueryClient {
	const qc = new QueryClient();
	qc.setQueryData(billingKeys.wallet, { balance_cents: 1_000 });
	qc.setQueryData(billingKeys.ledger(50), { items: [] });
	qc.setQueryData(billingKeys.subscriptionCreateQuote("compute_basic", 1, "wallet"), {
		term_price_cents: 1_500,
	});
	qc.setQueryData(billingKeys.deployments, []);
	qc.setQueryData(billingKeys.billingHistory(20), { pages: [] });
	qc.setQueryData(["get", "/v1/agents"], []);
	return qc;
}

function setupControls(queryClient: QueryClient) {
	const resetAttempt = mock(() => {});
	const closeDialog = mock(() => {});
	const startPayment = mock((_clientSecret: string) => {});
	const toastInfo = mock((_message: string, _options: { description: string }) => {});
	const toastError = mock((_message: string, _options: { description: string }) => {});
	const onComplete = mock((_status: "succeeded" | "processing") => {});
	return {
		queryClient,
		resetAttempt,
		closeDialog,
		startPayment,
		toastInfo,
		toastError,
		onComplete,
	};
}

describe("handleTopupStartResult", () => {
	test("treats synchronous success as terminal success and refreshes wallet activity", () => {
		const qc = queryClientWithWalletActivity();
		const setup = setupControls(qc);

		handleTopupStartResult(
			result({
				status: "succeeded",
				flow_type: "mock",
				payment_intent_id: "pi_sync_success",
				client_secret: null,
				amount_usd: "2.50",
			}),
			setup,
		);

		expect(qc.getQueryState(billingKeys.wallet)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(billingKeys.ledger(50))?.isInvalidated).toBe(true);
		expect(
			qc.getQueryState(billingKeys.subscriptionCreateQuote("compute_basic", 1, "wallet"))
				?.isInvalidated,
		).toBe(true);
		expect(qc.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(billingKeys.billingHistory(20))?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["get", "/v1/agents"])?.isInvalidated).toBe(true);
		expect(setup.resetAttempt).toHaveBeenCalledTimes(1);
		expect(setup.closeDialog).toHaveBeenCalledTimes(1);
		expect(setup.toastInfo).toHaveBeenCalledWith("Payment accepted", {
			description: "We're confirming your Wallet credit now.",
		});
		expect(setup.toastError).not.toHaveBeenCalled();
		expect(setup.startPayment).not.toHaveBeenCalled();
		expect(setup.onComplete).toHaveBeenCalledWith("succeeded");
	});

	test("keeps payment intents on the card step and refreshes only a visible ledger", async () => {
		const qc = queryClientWithWalletActivity();
		const setup = setupControls(qc);
		let ledgerCalls = 0;
		const ledgerObserver = new QueryObserver(qc, {
			queryKey: billingKeys.ledger(50),
			queryFn: async () => {
				ledgerCalls += 1;
				return { items: [{ id: "pending_topup" }] };
			},
			staleTime: Number.POSITIVE_INFINITY,
		});
		const unsubscribe = ledgerObserver.subscribe(() => {});

		handleTopupStartResult(
			result({
				status: "requires_payment_method",
				flow_type: "payment_intent",
				payment_intent_id: "pi_123",
				client_secret: "pi_123_secret_456",
				// The quoted USD amount does not mean the PaymentIntent settled.
				amount_usd: "25",
			}),
			setup,
		);
		await Promise.resolve();

		expect(setup.startPayment).toHaveBeenCalledWith("pi_123_secret_456");
		expect(ledgerCalls).toBe(1);
		expect(qc.getQueryState(billingKeys.wallet)?.isInvalidated).toBe(false);
		expect(qc.getQueryState(billingKeys.ledger(50))?.isInvalidated).toBe(false);
		expect(
			qc.getQueryState(billingKeys.subscriptionCreateQuote("compute_basic", 1, "wallet"))
				?.isInvalidated,
		).toBe(false);
		expect(qc.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(false);
		expect(qc.getQueryState(billingKeys.billingHistory(20))?.isInvalidated).toBe(false);
		expect(setup.closeDialog).not.toHaveBeenCalled();
		expect(setup.resetAttempt).not.toHaveBeenCalled();
		expect(setup.toastInfo).not.toHaveBeenCalled();
		expect(setup.toastError).not.toHaveBeenCalled();
		unsubscribe();
	});
});

describe("walletTopupCreditIsApplied", () => {
	const entry: WalletLedgerEntry = {
		operation: "topup",
		description: "Card top-up",
		amount_usd: "25.00",
		status: "applied",
		payment_reference: "pi_previous",
		receipt_url: null,
		created_at: "2026-07-27T12:00:00Z",
		applied_at: "2026-07-27T12:00:01Z",
	};

	test("confirms only the exact applied top-up payment reference", () => {
		expect(walletTopupCreditIsApplied("pi_current", [entry])).toBe(false);
		expect(walletTopupCreditIsApplied(null, [{ ...entry, payment_reference: null }])).toBe(false);
		expect(
			walletTopupCreditIsApplied("pi_current", [
				{ ...entry, payment_reference: "pi_current", status: "pending" },
			]),
		).toBe(false);
		expect(
			walletTopupCreditIsApplied("pi_current", [
				{ ...entry, payment_reference: "pi_current", operation: "x402" },
			]),
		).toBe(false);
		expect(
			walletTopupCreditIsApplied("pi_current", [
				{ ...entry, payment_reference: "pi_current", operation: "invoice" },
			]),
		).toBe(false);
		expect(
			walletTopupCreditIsApplied("pi_current", [{ ...entry, payment_reference: "pi_current" }]),
		).toBe(true);
	});

	test("reads the paginated Activity cache used by Wallet", async () => {
		const qc = new QueryClient();
		qc.setQueryData(billingKeys.ledgerPages(50), {
			pages: [{ items: [{ ...entry, payment_reference: "pi_current" }] }],
			pageParams: [null],
		});

		expect(await waitForWalletTopupCredit(qc, "pi_current")).toBe(true);
	});
});

describe("topUpAmountCentsForUsdShortfall", () => {
	test("rounds up to whole dollars and clamps to the allowed top-up range", () => {
		expect(topUpAmountCentsForUsdShortfall(4)).toBe(1_000);
		expect(topUpAmountCentsForUsdShortfall(14)).toBe(1_400);
		expect(topUpAmountCentsForUsdShortfall(25.001)).toBe(2_600);
		expect(topUpAmountCentsForUsdShortfall(2_500)).toBe(200_000);
	});

	test("ignores missing or invalid USD inputs", () => {
		expect(topUpAmountCentsForUsdShortfall(null)).toBeNull();
		expect(topUpAmountCentsForUsdShortfall(Number.NaN)).toBeNull();
	});
});

describe("validTopUpAmountCents", () => {
	test("enforces visible bounds and whole-dollar increments", () => {
		expect(validTopUpAmountCents(1_000)).toBe(true);
		expect(validTopUpAmountCents(200_000)).toBe(true);
		expect(validTopUpAmountCents(999)).toBe(false);
		expect(validTopUpAmountCents(1_001)).toBe(false);
		expect(validTopUpAmountCents(1_000.1)).toBe(false);
		expect(validTopUpAmountCents(Number.NaN)).toBe(false);
	});
});
