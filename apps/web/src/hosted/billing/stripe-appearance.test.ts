import { describe, expect, mock, test } from "bun:test";
import {
	stripeAppearanceForTheme,
	watchStripeThemeChanges,
} from "@/hosted/billing/stripe-appearance";

describe("Stripe appearance", () => {
	test("maps light and dark theme snapshots", () => {
		expect(stripeAppearanceForTheme(false).theme).toBe("stripe");
		expect(stripeAppearanceForTheme(true).theme).toBe("night");
	});

	test("updates immediately and on a live root theme change", () => {
		const update = mock(() => {});
		let notify = () => {};
		const disconnect = mock(() => {});

		const cleanup = watchStripeThemeChanges(update, (onMutation) => {
			notify = onMutation;
			return disconnect;
		});
		notify();
		cleanup();

		expect(update).toHaveBeenCalledTimes(2);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});
});
