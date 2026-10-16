import { describe, expect, test } from "bun:test";
import type { ComputeSubscriptionAction } from "./compute-subscription-actions";
import { appComputeActions, fundingSourcesFor } from "./store-billing-policy";

const direct = (
	kind: Exclude<ComputeSubscriptionAction["kind"], "fix_payment" | "top_up" | "start_new">,
) => ({ kind, disabledReason: null }) as const;
const startNew: ComputeSubscriptionAction = {
	kind: "start_new",
	disabledReason: null,
	recoveryTarget: { kind: "start_new", action: "start_new" },
};
const actions: readonly ComputeSubscriptionAction[] = [
	direct("upgrade"),
	direct("manage"),
	direct("check_change"),
	direct("cancel_scheduled_change"),
	direct("resume"),
	direct("end_trial"),
	direct("cancel"),
	startNew,
];
const kinds = (storeBuild: boolean, fundingSource: string | null) =>
	appComputeActions(storeBuild, { fundingSource }, actions).map((action): string => action.kind);

describe("store billing policy (D-1 card half, Wallet aligned with Web)", () => {
	const all = [
		"upgrade",
		"manage",
		"check_change",
		"cancel_scheduled_change",
		"resume",
		"end_trial",
		"cancel",
		"start_new",
	];

	test("other builds keep Web's actions for every row", () => {
		for (const fundingSource of ["stripe", "wallet", "store", null]) {
			expect(kinds(false, fundingSource)).toEqual(all);
		}
	});

	test("store builds offer card rows only actions that never charge the card", () => {
		expect(kinds(true, "stripe")).toEqual([
			"cancel_scheduled_change",
			"end_trial",
			"cancel",
			"start_new",
		]);
	});

	test("store builds keep Web's full set for Wallet rows and Included Basic", () => {
		expect(kinds(true, "wallet")).toEqual(all);
		expect(kinds(true, null)).toEqual(all);
	});

	test("recovery keeps its own paths and disabled actions keep their reason", () => {
		const filtered = appComputeActions(false, { fundingSource: "wallet" }, [
			{ ...startNew, disabledReason: "Checking paid compute availability…" },
			{
				kind: "top_up",
				disabledReason: null,
				recoveryTarget: { kind: "top_up", action: "top_up" },
			},
		]);
		expect(filtered.map((action) => [action.kind, action.disabledReason])).toEqual([
			["start_new", "Checking paid compute availability…"],
		]);
	});

	test("new subscriptions are Wallet-funded in every build; card plan changes only off-store", () => {
		expect(fundingSourcesFor(false, "new_subscription")).toEqual(["wallet"]);
		expect(fundingSourcesFor(true, "new_subscription")).toEqual(["wallet"]);
		expect(fundingSourcesFor(false, "plan_change")).toEqual(["stripe", "wallet"]);
		expect(fundingSourcesFor(true, "plan_change")).toEqual(["wallet"]);
	});
});
