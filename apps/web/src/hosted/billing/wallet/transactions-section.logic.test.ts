import { describe, expect, test } from "bun:test";
import type { WalletTransaction } from "@/hosted/billing/contracts";
import {
	transactionComputeDetails,
	transactionKindLabel,
	transactionSignedAmount,
} from "./transactions-section.logic";

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

	test("signs the backend's positive Decimal amount from its direction", () => {
		expect(transactionSignedAmount(transaction())).toBe("+$25.00");
		expect(transactionSignedAmount(transaction({ amount: "19.995", direction: "debit" }))).toBe(
			"−$20.00",
		);
	});

	test("shows compute plan, agent, period, and deleted-agent fallback", () => {
		const context = {
			plan: "compute_performance",
			period_start: "2026-07-01T00:00:00Z",
			period_end: "2026-08-01T00:00:00Z",
			agent_name: "Research",
			deployment_id: "hdep_test",
		};
		expect(transactionComputeDetails(transaction({ kind: "compute_charge", context }))).toEqual([
			"Performance · Research",
			"Jul 1, 2026 – Aug 1, 2026",
		]);
		expect(
			transactionComputeDetails(
				transaction({ kind: "compute_credit", context: { ...context, deployment_id: null } }),
			),
		).toEqual(["Performance · Deleted agent", "Jul 1, 2026 – Aug 1, 2026"]);
		expect(transactionComputeDetails(transaction({ kind: "compute_charge" }))).toEqual([
			"Compute · Deleted agent",
			"—",
		]);
	});
});
