import { describe, expect, test } from "bun:test";
import {
	computePurchaseErrorNotice,
	computePurchaseNotice,
	creditPrice,
	formatCreditCents,
	formatCredits,
	pendingCheckNotice,
	purchaseErrorNotice,
	purchaseOutcomeNotice,
	restorePurchasesNotices,
	signedCredits,
	storeContractIdForRow,
} from "./store-presentation";

describe("credit units", () => {
	test("never render a dollar sign", () => {
		expect(formatCredits("1234.5", "credits")).toBe("1,234.50 credits");
		expect(formatCredits("-3.004", "credits")).toBe("-3.00 credits");
		expect(formatCredits("0.001", "credits")).toBe("<0.01 credits");
		expect(formatCredits("invalid", "credits")).toBe("—");
		expect(formatCreditCents(2500, "credits")).toBe("25.00 credits");
		expect(signedCredits("−$25.00", "credits")).toBe("−25.00 credits");
	});

	test("only USD prices have a credit equivalent", () => {
		expect(creditPrice({ price_cents: 999, currency: "USD" }, "credits")).toBe("9.99 credits");
		expect(creditPrice({ price_cents: 999, currency: "eur" }, "credits")).toBeNull();
		expect(creditPrice({ price_cents: null, currency: "usd" }, "credits")).toBeNull();
	});
});

describe("purchase notices", () => {
	const outcome = (
		status: Parameters<typeof purchaseOutcomeNotice>[0]["status"],
		state = "prepared",
	) => ({ status, attempt: { state } }) as Parameters<typeof purchaseOutcomeNotice>[0];

	test("funded and submitted purchases refresh the Wallet balance", () => {
		expect(purchaseOutcomeNotice(outcome("funding_applied", "funding_applied"), null)).toEqual({
			key: "store.fundingApplied",
			tone: "success",
			refresh: true,
		});
		expect(purchaseOutcomeNotice(outcome("submitted", "expired"), null)).toMatchObject({
			key: "store.submitted",
			refresh: true,
		});
	});

	test("dismissal is silent unless the Paywall itself was unavailable", () => {
		expect(purchaseOutcomeNotice(outcome("cancelled"), null)).toBeNull();
		expect(purchaseOutcomeNotice(outcome("cancelled"), "paywall_unavailable")).toMatchObject({
			key: "store.paywallUnavailable",
		});
	});

	test("a reconciliation hold asks for review instead of another purchase", () => {
		expect(
			purchaseOutcomeNotice(outcome("terminal", "reconciliation_required"), null),
		).toMatchObject({ key: "store.reviewRequired" });
	});

	test("deferred and uncertain purchases are never shown as failures to retry blindly", () => {
		expect(purchaseErrorNotice("payment_pending").key).toBe("store.paymentPending");
		for (const code of ["purchase_unconfirmed", "store_operation_timeout"] as const)
			expect(purchaseErrorNotice(code)).toMatchObject({ key: "store.unconfirmed", refresh: true });
		expect(purchaseErrorNotice("purchase_pending").key).toBe("store.purchaseInProgress");
		expect(purchaseErrorNotice("store_purchases_disabled").key).toBe("store.unavailable");
	});

	test("checking pending purchases reports the most actionable recovered outcome", () => {
		expect(pendingCheckNotice([])).toEqual({
			key: "store.noPending",
			tone: "neutral",
			refresh: false,
		});
		expect(pendingCheckNotice([outcome("cancelled")]).key).toBe("store.noPending");
		expect(
			pendingCheckNotice([outcome("pending"), outcome("funding_applied", "funding_applied")]),
		).toMatchObject({ key: "store.fundingApplied", refresh: true });
		expect(
			pendingCheckNotice([
				outcome("funding_applied", "funding_applied"),
				outcome("terminal", "reconciliation_required"),
			]).key,
		).toBe("store.reviewRequired");
	});
});

describe("compute subscription results", () => {
	const outcome = (
		status: "funding_applied" | "submitted" | "terminal" | "pending" | "cancelled",
		state: "funding_applied" | "rejected" | "reconciliation_required" | "prepared" = "prepared",
	) => ({ status, attempt: { state } });

	test("a funded deploy continues to admission; upgrades and changes confirm", () => {
		expect(
			computePurchaseNotice(outcome("funding_applied"), null, "deploy", "Google Play"),
		).toBeNull();
		expect(
			computePurchaseNotice(outcome("funding_applied"), null, "upgrade", "Google Play"),
		).toEqual({
			key: "storeCompute.upgraded",
			tone: "success",
			refresh: true,
			values: { store: "Google Play" },
		});
		expect(
			computePurchaseNotice(outcome("funding_applied"), null, "change", "App Store")?.key,
		).toBe("storeCompute.changed");
	});

	test("a closed Paywall or cancelled sheet leaves the draft without a notice", () => {
		expect(computePurchaseNotice(outcome("cancelled"), null, "deploy", "App Store")).toBeNull();
		expect(
			computePurchaseNotice(outcome("cancelled"), "paywall_unavailable", "deploy", "App Store")
				?.key,
		).toBe("storeCompute.unavailable");
	});

	test("Ask-to-Buy / Play PENDING waits for approval and never deploys", () => {
		expect(computePurchaseErrorNotice("payment_pending", "deploy", "App Store")).toMatchObject({
			key: "storeCompute.waitingForApproval",
			tone: "neutral",
		});
		expect(computePurchaseErrorNotice("payment_pending", "upgrade", "App Store").key).toBe(
			"storeCompute.waitingForApprovalUpgrade",
		);
	});

	test("held and unfinished attempts are distinct from success", () => {
		expect(
			computePurchaseNotice(outcome("terminal", "reconciliation_required"), null, "deploy", "x")
				?.key,
		).toBe("store.reviewRequired");
		expect(computePurchaseNotice(outcome("terminal", "rejected"), null, "deploy", "x")?.key).toBe(
			"storeCompute.notCompleted",
		);
		expect(computePurchaseNotice(outcome("pending"), null, "deploy", "x")?.key).toBe(
			"storeCompute.processing",
		);
		expect(computePurchaseErrorNotice("purchase_unconfirmed", "deploy", "x").key).toBe(
			"storeCompute.unconfirmed",
		);
	});
});

describe("restore purchases", () => {
	test("names another account's subscription without moving it, alongside restored ones", () => {
		const notices = restorePurchasesNotices(
			{
				code: "reconciled",
				results: [
					{ code: "reconciled", subscription_id: "a", contract_id: null },
					{ code: "owned_by_other_account", subscription_id: null, contract_id: null },
				],
			},
			"App Store",
		);
		expect(notices.map((notice) => notice.key)).toEqual([
			"storeCompute.ownedByOtherAccount",
			"storeCompute.restored",
		]);
		expect(notices[0]?.values).toEqual({ store: "App Store" });
	});

	test("pending reconciliation is reported as pending", () => {
		expect(
			restorePurchasesNotices({ code: "reconciliation_pending", results: [] }, "Google Play").map(
				(notice) => notice.key,
			),
		).toEqual(["storeCompute.restorePending"]);
	});
});

describe("store contract for a subscription row", () => {
	const management = {
		provider: "play_store" as const,
		product_id: "ai.clawdi.app.compute:basic-monthly",
		management_url: null,
		auto_renews: true,
		renews_or_ends_at: null,
		state: "active",
	};
	const row = { deployment_id: "hdep_a", store_management: management };
	const slot = {
		available: false,
		contract_id: "11111111-1111-4111-8111-111111111111",
		agent_id: "hdep_a",
		store_management: management,
	};

	test("matches the live contract bound to the row's Agent or unbound", () => {
		expect(storeContractIdForRow(row, slot)).toBe(slot.contract_id);
		expect(
			storeContractIdForRow({ ...row, deployment_id: null }, { ...slot, agent_id: null }),
		).toBe(slot.contract_id);
	});

	test("has no contract for another Agent, another product or an open slot", () => {
		expect(storeContractIdForRow({ ...row, deployment_id: "hdep_b" }, slot)).toBeNull();
		expect(
			storeContractIdForRow(
				{
					...row,
					store_management: { ...management, product_id: "ai.clawdi.app.compute:basic-annual" },
				},
				slot,
			),
		).toBeNull();
		expect(storeContractIdForRow(row, { available: true })).toBeNull();
		expect(storeContractIdForRow(row, null)).toBeNull();
	});
});
