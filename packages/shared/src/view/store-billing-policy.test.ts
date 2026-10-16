import { describe, expect, test } from "bun:test";
import type { ComputeSubscriptionAction } from "./compute-subscription-actions";
import { computeFundingSource } from "./compute-subscriptions";
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
type Row = Parameters<typeof computeFundingSource>[1];
// Callers classify rows from the normalized source, exactly like the app's call sites.
const kinds = (
	storeBuild: boolean,
	planSlug: string,
	row: Row,
	list: readonly ComputeSubscriptionAction[] = actions,
) =>
	appComputeActions(storeBuild, { fundingSource: computeFundingSource(planSlug, row) }, list).map(
		(action): string => action.kind,
	);
const card: Row = { funding_source: "stripe", price_cents: 2500 };
const wallet: Row = { funding_source: "wallet", price_cents: 2500 };
const store: Row = { funding_source: "store", price_cents: null };
const legacyCard: Row = { funding_source: null, price_cents: 2500 };
const included: Row = { funding_source: null, price_cents: 0 };
const noCharge = ["cancel_scheduled_change", "end_trial", "cancel", "start_new"];

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
		for (const row of [card, wallet, store, legacyCard, included]) {
			expect(kinds(false, "compute_basic", row)).toEqual(all);
		}
	});

	test("store builds offer card rows only actions that never charge the card", () => {
		expect(kinds(true, "compute_performance", card)).toEqual(noCharge);
	});

	test("a store build treats a paid row with null funding as card: no resume, no manage", () => {
		expect(
			kinds(
				true,
				"compute_performance",
				legacyCard,
				actions.filter((action) => action.kind !== "start_new"),
			),
		).toEqual(["cancel_scheduled_change", "end_trial", "cancel"]);
		// Malformed funding the app can't classify never offers a charging action either.
		expect(kinds(true, "compute_performance", { funding_source: null, price_cents: 0 })).toEqual(
			noCharge,
		);
	});

	test("store builds keep Web's full set for Wallet rows and Included Basic", () => {
		expect(kinds(true, "compute_performance", wallet)).toEqual(all);
		expect(kinds(true, "compute_basic", included)).toEqual(all);
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
