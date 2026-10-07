import { describe, expect, test } from "bun:test";
import { formatShortDate } from "@clawdi/shared/view";
import type { DeployComponents } from "../api";

type WalletTransaction = DeployComponents["schemas"]["V2WalletTransactionItemResponse"];

import {
	transactionComputeDetails,
	transactionKindLabel,
	transactionPaymentSourceLabel,
	transactionSignedAmount,
} from "./wallet-transactions";

// Period dates render in the viewer's timezone, so the expected strings are
// built with the same formatter; the assertions cover the assembly, not Intl.
const PERIOD_START = "2026-07-01T00:00:00Z";
const PERIOD_END = "2026-08-01T00:00:00Z";
const PERIOD = `${formatShortDate(PERIOD_START)} – ${formatShortDate(PERIOD_END)}`;

function transaction(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
	return {
		id: "wallet:test",
		kind: "topup",
		occurred_at: "2026-07-01T00:00:00Z",
		amount: "25.00",
		currency: "usd",
		direction: "credit",
		status: "applied",
		funding: "wallet",
		...overrides,
	};
}

describe("transaction presentation", () => {
	test("uses human labels without exposing unknown backend kinds", () => {
		expect(transactionKindLabel("auto_reload")).toBe("Auto-reload");
		expect(transactionKindLabel("compute_credit")).toBe("Compute credit");
		expect(transactionKindLabel("internal_migration_v3")).toBe("Other transaction");
	});

	test("labels in-app purchases and their refunds with the store as the source", () => {
		// Hosted lists store_topup as a store-funded credit and store_refund as a Wallet debit.
		const purchase = transaction({ kind: "store_topup", amount: "10.00", funding: "store" });
		const refund = transaction({ kind: "store_refund", amount: "10.00", direction: "debit" });
		expect(transactionKindLabel(purchase.kind)).toBe("In-app purchase");
		expect(transactionPaymentSourceLabel(purchase.funding)).toBe("App store");
		expect(transactionSignedAmount(purchase)).toBe("+$10.00");
		expect(transactionKindLabel(refund.kind)).toBe("In-app purchase refund");
		expect(transactionPaymentSourceLabel(refund.funding)).toBe("Wallet");
		expect(transactionSignedAmount(refund)).toBe("−$10.00");
	});

	test("signs the backend's positive Decimal amount from its direction", () => {
		expect(transactionSignedAmount(transaction())).toBe("+$25.00");
		expect(transactionSignedAmount(transaction({ amount: "19.995", direction: "debit" }))).toBe(
			"−$20.00",
		);
	});

	test("shows compute plan, agent, period, and deleted-agent fallback", () => {
		const context = {
			plan: "compute_performance",
			period_start: PERIOD_START,
			period_end: PERIOD_END,
			agent_name: "Research",
			deployment_id: "hdep_test",
		};
		expect(transactionComputeDetails(transaction({ kind: "compute_charge", context }))).toEqual([
			"Performance · Research",
			PERIOD,
		]);
		expect(
			transactionComputeDetails(
				transaction({ kind: "compute_credit", context: { ...context, deployment_id: null } }),
			),
		).toEqual(["Performance · Deleted agent", PERIOD]);
		expect(transactionComputeDetails(transaction({ kind: "compute_charge" }))).toEqual([
			"Plan · Deleted agent",
			"—",
		]);
	});
});
