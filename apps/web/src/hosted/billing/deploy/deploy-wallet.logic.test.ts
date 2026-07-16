import { describe, expect, test } from "bun:test";
import type { WalletComputeActivateResult } from "@/hosted/billing/contracts";
import { BillingApiError, BillingNetworkError } from "@/hosted/billing/errors";
import {
	resolveWalletDeploymentId,
	walletActivationFailure,
	walletPaymentDisabledReason,
} from "./deploy-wallet.logic";

describe("walletActivationFailure", () => {
	test("extracts the 402 shortfall", () => {
		const error = new BillingApiError(402, "insufficient", {
			detail: {
				code: "insufficient_wallet_balance",
				required_credits: "19000.0000",
				available_credits: "4999.5000",
				shortfall_credits: "14000.5000",
			},
		});
		expect(walletActivationFailure(error)).toMatchObject({
			kind: "insufficient",
			code: "insufficient_wallet_balance",
			shortfallCredits: 14_000.5,
			topUpCredits: 14_000.5,
		});
	});

	test("prefills enough to repay refund debt before the blocked charge", () => {
		const failure = walletActivationFailure(
			new BillingApiError(409, "refund debt", {
				detail: { code: "open_refund_debt", outstanding_debt_credits: "2500.5" },
			}),
			9_000,
		);
		expect(failure).toMatchObject({
			kind: "refund_debt",
			debtCredits: 2_500.5,
			topUpCredits: 11_500.5,
		});
	});

	test("separates conflicts from retryable ambiguous failures", () => {
		expect(
			walletActivationFailure(
				new BillingApiError(409, "conflict", {
					detail: { code: "deploy_request_funding_conflict" },
				}),
			).kind,
		).toBe("conflict");
		expect(
			walletActivationFailure(
				new BillingApiError(502, "upstream", {
					detail: { code: "wallet_compute_upstream_failed", retryable: true },
				}),
			).kind,
		).toBe("retryable");
		expect(walletActivationFailure(new BillingNetworkError("offline")).kind).toBe("retryable");
	});
});

function activation(deploymentId: string | null): WalletComputeActivateResult {
	return {
		subscription_id: 42,
		status: "active",
		funding_source: "wallet",
		deploy_request_id: "wallet-request-42",
		deployment_id: deploymentId,
		charge_ledger_id: "ledger-42",
		charged_credits: "19000.0000",
		post_charge_balance_credits: "6000.0000",
		current_period_start: "2026-07-15T12:00:00Z",
		current_period_end: "2026-08-15T12:00:00Z",
		entitled_until: "2026-08-15T12:00:00Z",
	};
}

describe("resolveWalletDeploymentId", () => {
	test("uses the activation linkage without polling", async () => {
		let lookups = 0;
		const result = await resolveWalletDeploymentId(activation("hdep_direct"), async () => {
			lookups += 1;
			throw new Error("should not poll");
		});
		expect(result).toEqual({ kind: "resolved", deploymentId: "hdep_direct" });
		expect(lookups).toBe(0);
	});

	test("polls the stable deploy request through a transient 404", async () => {
		let lookups = 0;
		const delays: number[] = [];
		const result = await resolveWalletDeploymentId(
			activation(null),
			async (requestId) => {
				lookups += 1;
				if (lookups === 1) throw new BillingApiError(404, "Deployment request not found");
				return {
					deploy_request_id: requestId,
					request_status: lookups === 2 ? "processing" : "succeeded",
					deployment_id: lookups === 3 ? "hdep_resolved" : null,
					deployment_status: lookups === 3 ? "provisioning" : null,
				};
			},
			{
				delay: async (milliseconds) => {
					delays.push(milliseconds);
				},
			},
		);
		expect(result).toEqual({ kind: "resolved", deploymentId: "hdep_resolved" });
		expect(delays).toEqual([1_000, 1_500]);
	});

	test("stops polling when the deploy request reaches a terminal failure", async () => {
		const result = await resolveWalletDeploymentId(activation(null), async (requestId) => ({
			deploy_request_id: requestId,
			request_status: "failed",
			deployment_id: null,
			deployment_status: null,
		}));
		expect(result).toEqual({ kind: "terminal", requestStatus: "failed" });
	});
});

describe("walletPaymentDisabledReason", () => {
	test("keeps wallet visible but unavailable for annual terms", () => {
		expect(walletPaymentDisabledReason(1)).toBeNull();
		expect(walletPaymentDisabledReason(12)).toContain("renews monthly");
	});
});
