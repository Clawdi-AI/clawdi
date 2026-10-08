import { describe, expect, test } from "bun:test";
import { validateAndBuildHostedDeployRequest } from "@clawdi/shared/api";
import {
	type CreationAttempt,
	canAdmitCreationAttempt,
	canDiscardCreationAttempt,
	canStartStorePurchase,
	parseCreationAttempt,
	storeFundingAfterCheck,
	storeFundingHoldsAttempt,
	unboundStoreSlotPlan,
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

const plan = "compute_performance";
const noSlot = null;

describe("store-funded creation admission", () => {
	const other = {
		purpose: "compute_subscription" as const,
		pending_deploy_request_id: "other-request",
		state: "funding_applied" as const,
	};
	const own = { ...other, pending_deploy_request_id: id };

	test("Check status admits only this request's funded attempt while a live one remains", () => {
		const check = (attempts: Parameters<typeof storeFundingAfterCheck>[1]) =>
			storeFundingAfterCheck(id, attempts, "purchase_pending", plan, noSlot);
		expect(check([other, { ...own, state: "verification_pending" }])).toBe("purchase_pending");
		expect(check([{ ...own, state: "prepared" }])).toBe("purchase_pending");
		expect(check([own])).toBe("funded");
		// A locally cancelled request keeps its retry while its prepared attempt lives on.
		expect(
			storeFundingAfterCheck(id, [{ ...own, state: "prepared" }], "awaiting_purchase", plan, null),
		).toBe("awaiting_purchase");
	});

	test("an expired or missing attempt returns the request to awaiting_purchase", () => {
		for (const attempts of [
			[{ ...own, state: "expired" as const }],
			[{ ...own, state: "rejected" as const }],
			[{ ...own, state: "canceled" as const }],
			[{ ...own, purpose: "standalone_topup" as const }],
			[],
		]) {
			const funding = storeFundingAfterCheck(id, attempts, "purchase_pending", plan, noSlot);
			expect(funding).toBe("awaiting_purchase");
			expect(canAdmitCreationAttempt({ storeFunding: funding })).toBe(false);
		}
	});

	test("an expired attempt plus an unbound slot of the same plan allows admission", () => {
		const expired = [{ ...own, state: "expired" as const }];
		const funding = storeFundingAfterCheck(id, expired, "purchase_pending", plan, plan);
		expect(funding).toBe("funded");
		expect(canAdmitCreationAttempt({ storeFunding: funding })).toBe(true);
		// A slot of another plan cannot be bound by this request.
		const other = storeFundingAfterCheck(id, expired, "purchase_pending", plan, "compute_basic");
		expect(other).toBe("awaiting_purchase");
		expect(canAdmitCreationAttempt({ storeFunding: other })).toBe(false);
		// A live attempt is never bypassed by a slot.
		expect(
			storeFundingAfterCheck(id, [{ ...own, state: "prepared" }], "purchase_pending", plan, plan),
		).toBe("purchase_pending");
	});

	test("reconciliation_required blocks admission and allows discarding the draft", () => {
		const fromCheck = storeFundingAfterCheck(
			id,
			[{ ...own, state: "reconciliation_required" }],
			"purchase_pending",
			plan,
			plan,
		);
		const funding = fromCheck;
		expect(funding).toBe("review_required");
		const attempt = storeAttempt(funding);
		expect(canAdmitCreationAttempt(attempt)).toBe(false);
		expect(canStartStorePurchase(attempt)).toBe(false);
		expect(canDiscardCreationAttempt(attempt) && !storeFundingHoldsAttempt(attempt)).toBe(true);
	});

	test("unbound store slots are matched by plan and supplying state only", () => {
		const management = {
			contract_id: "11111111-1111-4111-8111-111111111111",
			provider: "app_store" as const,
			product_id: "ai.clawdi.app.compute.performance.monthly",
			management_url: null,
			auto_renews: true,
			renews_or_ends_at: null,
			state: "active",
		};
		const planOf = (productId: string) =>
			productId.includes("performance") ? "compute_performance" : "compute_basic";
		const slot = {
			available: false,
			contract_id: "c",
			agent_id: null,
			store_management: management,
		};
		expect(unboundStoreSlotPlan(slot, planOf)).toBe("compute_performance");
		expect(unboundStoreSlotPlan({ ...slot, agent_id: "hdep_bound" }, planOf)).toBeNull();
		expect(unboundStoreSlotPlan({ available: true }, planOf)).toBeNull();
		expect(
			unboundStoreSlotPlan(
				{ ...slot, store_management: { ...management, state: "lapsed" } },
				planOf,
			),
		).toBeNull();
		expect(unboundStoreSlotPlan(null, planOf)).toBeNull();
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
