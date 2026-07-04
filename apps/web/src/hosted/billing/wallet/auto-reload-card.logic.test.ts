import { describe, expect, test } from "bun:test";
import { autoReloadFormState } from "./auto-reload-card.logic";

const validForm = {
	amount: "25",
	threshold: "1",
	cap: "100",
	pointsPerUsd: 1000,
};

describe("autoReloadFormState", () => {
	test("rejects a blank monthly cap instead of converting it to no cap", () => {
		const state = autoReloadFormState({ ...validForm, cap: "" });

		expect(Number.isNaN(state.capCents)).toBe(true);
		expect(state.capValid).toBe(false);
		expect(state.formValid).toBe(false);
	});

	test("keeps an explicit 0 monthly cap as the no-cap value", () => {
		const state = autoReloadFormState({ ...validForm, cap: "0" });

		expect(state.capCents).toBe(0);
		expect(state.capValid).toBe(true);
		expect(state.formValid).toBe(true);
	});

	test("preserves the $1 threshold floor at 1000 points per USD", () => {
		expect(autoReloadFormState({ ...validForm, threshold: "0.99" }).thresholdValid).toBe(false);
		expect(autoReloadFormState({ ...validForm, threshold: "1" }).thresholdValid).toBe(true);
	});
});
