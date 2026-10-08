import { describe, expect, test } from "bun:test";
import { validateAndBuildHostedDeployRequest } from "@clawdi/shared/api";
import {
	type CreationAttempt,
	canAdmitCreationAttempt,
	canStartStorePurchase,
	parseCreationAttempt,
	storeFundingAfterCheck,
	storeFundingAfterPurchase,
	storeFundingHoldsAttempt,
} from "@/hosted/billing/deploy/deploy-request";
import { createAttemptStore } from "@/platform/creation-attempt-store";

const id = "8e244ab3-1111-4111-8111-111111111111";

function storeAttempt(storeFunding: CreationAttempt["storeFunding"]): CreationAttempt {
	const draft = {
		runtime: "hermes",
		computePlanSlug: "compute_performance",
		agentName: "Agent",
		language: "en",
		timezone: "",
		ai: { mode: "unmanaged" },
	} as const;
	const result = validateAndBuildHostedDeployRequest(draft);
	if (!result.ok) throw new Error("Invalid fixture");
	return {
		version: 1,
		submission: "prepared",
		id,
		draft,
		request: { ...result.request, deploy_request_id: id },
		...(storeFunding ? { storeFunding } : {}),
	};
}

const outcome = (
	status: "funding_applied" | "submitted" | "terminal" | "pending" | "cancelled",
	state:
		| "funding_applied"
		| "rejected"
		| "canceled"
		| "expired"
		| "reconciliation_required"
		| "prepared" = "prepared",
) => ({ outcome: { status, attempt: { state } } });

describe("store-funded creation admission", () => {
	test("pending, unconfirmed and unfinished purchases never allow admission", () => {
		for (const result of [
			{ error: "payment_pending" as const },
			{ error: "purchase_unconfirmed" as const },
			{ error: "store_operation_timeout" as const },
			{ error: "store_request_failed" as const },
			{ error: "account_changed" as const },
			outcome("pending"),
			outcome("submitted"),
			outcome("terminal", "expired"),
			outcome("terminal", "reconciliation_required"),
		]) {
			const funding = storeFundingAfterPurchase(result);
			expect(funding).toBe("purchase_pending");
			expect(canAdmitCreationAttempt({ storeFunding: funding })).toBe(false);
			expect(canStartStorePurchase(storeAttempt(funding))).toBe(false);
		}
	});

	test("only this request's funding_applied allows admission", () => {
		expect(storeFundingAfterPurchase(outcome("funding_applied", "funding_applied"))).toBe("funded");
		expect(canAdmitCreationAttempt({ storeFunding: "funded" })).toBe(true);
		expect(canAdmitCreationAttempt({ storeFunding: "awaiting_purchase" })).toBe(false);
		expect(canAdmitCreationAttempt({})).toBe(true);
	});

	test("a cancelled or provably unstarted purchase can be retried, not admitted", () => {
		for (const result of [
			outcome("cancelled"),
			outcome("terminal", "rejected"),
			{ error: "paywall_unavailable" as const },
			{ error: "store_offering_unavailable" as const },
		]) {
			const funding = storeFundingAfterPurchase(result);
			expect(funding).toBe("awaiting_purchase");
			expect(canAdmitCreationAttempt({ storeFunding: funding })).toBe(false);
			expect(canStartStorePurchase(storeAttempt(funding))).toBe(true);
		}
	});

	test("Check status enables admission only from this request's funded attempt", () => {
		const other = {
			purpose: "compute_subscription" as const,
			pending_deploy_request_id: "other-request",
			state: "funding_applied" as const,
		};
		const own = { ...other, pending_deploy_request_id: id };
		expect(
			storeFundingAfterCheck(
				id,
				[other, { ...own, state: "verification_pending" }],
				"purchase_pending",
			),
		).toBe("purchase_pending");
		expect(
			storeFundingAfterCheck(id, [{ ...own, purpose: "standalone_topup" }], "purchase_pending"),
		).toBe("purchase_pending");
		expect(storeFundingAfterCheck(id, [], "purchase_pending")).toBe("purchase_pending");
		expect(storeFundingAfterCheck(id, [own], "purchase_pending")).toBe("funded");
		expect(storeFundingAfterCheck(id, [{ ...own, state: "rejected" }], "purchase_pending")).toBe(
			"awaiting_purchase",
		);
		expect(storeFundingAfterCheck(id, [{ ...own, state: "expired" }], "purchase_pending")).toBe(
			"purchase_pending",
		);
	});

	test("a restart mid-purchase restores the store gate from the creation journal", async () => {
		const values = new Map<string, string>();
		const store = {
			getItemAsync: async (key: string) => values.get(key) ?? null,
			setItemAsync: async (key: string, value: string) => {
				values.set(key, value);
			},
			deleteItemAsync: async (key: string) => {
				values.delete(key);
			},
		};
		const awaiting = storeAttempt("awaiting_purchase");
		await createAttemptStore(store).saveAttempt("account", awaiting, () => true);
		const pending = storeAttempt("purchase_pending");
		await createAttemptStore(store).replaceAttempt("account", awaiting, pending, () => true);

		const restarted = await createAttemptStore(store).readSavedAttempt("account");
		expect(restarted).toEqual(pending);
		if (!restarted) throw new Error("Missing journal");
		expect(canAdmitCreationAttempt(restarted)).toBe(false);
		expect(canStartStorePurchase(restarted)).toBe(false);
		expect(storeFundingHoldsAttempt(restarted)).toBe(true);

		const funded = storeAttempt("funded");
		await createAttemptStore(store).replaceAttempt("account", restarted, funded, () => true);
		const afterCheck = await createAttemptStore(store).readSavedAttempt("account");
		expect(afterCheck && canAdmitCreationAttempt(afterCheck)).toBe(true);
	});

	test("journals reject unknown store funding values", () => {
		expect(
			parseCreationAttempt(JSON.stringify({ ...storeAttempt(undefined), storeFunding: "paid" })),
		).toBeNull();
		expect(parseCreationAttempt(JSON.stringify(storeAttempt(undefined)))).toEqual(
			storeAttempt(undefined),
		);
	});
});
