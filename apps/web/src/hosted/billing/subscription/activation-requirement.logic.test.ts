import { describe, expect, test } from "bun:test";
import { activationRequirement } from "./activation-requirement.logic";

type SubSlice = Parameters<typeof activationRequirement>[0];

const sub = (over: Partial<NonNullable<SubSlice>> = {}): NonNullable<SubSlice> => ({
	card_setup_required: false,
	activation_fee_amount_cents: 0,
	activation_fee_satisfied: true,
	...over,
});

describe("activationRequirement", () => {
	test("nothing required when no fee and no card setup", () => {
		expect(activationRequirement(sub(), null).required).toBe(false);
		expect(activationRequirement(null, null).required).toBe(false);
	});

	test("an unmet fee from the focused status gates", () => {
		const r = activationRequirement(sub(), { amount_cents: 500, satisfied: false });
		expect(r).toMatchObject({
			required: true,
			feeDue: true,
			cardSetup: false,
			feeAmountCents: 500,
		});
	});

	test("a satisfied fee does not gate", () => {
		const r = activationRequirement(sub(), { amount_cents: 500, satisfied: true });
		expect(r.required).toBe(false);
		expect(r.feeDue).toBe(false);
	});

	test("card_setup_required gates even with no fee", () => {
		const r = activationRequirement(sub({ card_setup_required: true }), null);
		expect(r).toMatchObject({ required: true, cardSetup: true, feeDue: false });
	});

	test("falls back to the subscription snapshot when the fee query is absent", () => {
		const r = activationRequirement(
			sub({ activation_fee_amount_cents: 1000, activation_fee_satisfied: false }),
			null,
		);
		expect(r).toMatchObject({ required: true, feeDue: true, feeAmountCents: 1000 });
	});

	test("the focused status wins over the snapshot", () => {
		// Snapshot says unsatisfied, but the fresh status says satisfied → no gate.
		const r = activationRequirement(
			sub({ activation_fee_amount_cents: 1000, activation_fee_satisfied: false }),
			{ amount_cents: 1000, satisfied: true },
		);
		expect(r.feeDue).toBe(false);
		expect(r.required).toBe(false);
	});
});
