import { describe, expect, test } from "bun:test";
import type { StoreComputeSlot } from "@clawdi/shared/api";
import { mobileAccountDeletionStoreNotice } from "./account-deletion-store";

const management = {
	contract_id: "11111111-1111-4111-8111-111111111111",
	provider: "app_store" as const,
	product_id: "ai.clawdi.app.compute.basic.monthly",
	management_url: null,
	auto_renews: false,
	renews_or_ends_at: "2026-11-01T00:00:00Z",
	state: "active",
};
const card = { funding_source: "stripe" as const, store_management: null };
const slot = (state: string, auto_renews = false): StoreComputeSlot => ({
	available: false,
	contract_id: "11111111-1111-4111-8111-111111111111",
	store_management: { ...management, state, auto_renews },
});

describe("mobile account deletion store pre-step", () => {
	test("a renewable store row or slot names its store", () => {
		const row = { funding_source: "store" as const, store_management: management };
		expect(mobileAccountDeletionStoreNotice([row], true, null)).toMatchObject({
			kind: "store",
			management: { provider: "app_store" },
		});
		expect(mobileAccountDeletionStoreNotice([card], true, slot("conflict_hold"))).toMatchObject({
			kind: "store",
			management: { provider: "app_store" },
		});
		// The list can still be loading; the slot alone is enough evidence.
		expect(mobileAccountDeletionStoreNotice(null, false, slot("grace"))).toMatchObject({
			kind: "store",
			management: { provider: "app_store" },
		});
	});

	test("auto-renewal alone keeps the step even in a non-renewable state", () => {
		expect(mobileAccountDeletionStoreNotice([card], true, slot("expired", true))).toMatchObject({
			kind: "store",
			management: { provider: "app_store" },
		});
	});

	test("no live store contract shows no step; unknown data stays generic", () => {
		expect(mobileAccountDeletionStoreNotice([card], true, { available: true })).toEqual({
			kind: "none",
		});
		expect(mobileAccountDeletionStoreNotice([card], false, null)).toEqual({ kind: "generic" });
		expect(mobileAccountDeletionStoreNotice(null, false, null)).toEqual({ kind: "generic" });
		expect(mobileAccountDeletionStoreNotice(null, false, slot("expired"))).toEqual({
			kind: "generic",
		});
	});
});
