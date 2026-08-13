import { describe, expect, mock, test } from "bun:test";
import {
	stripeAppearanceForTheme,
	watchStripeThemeChanges,
} from "@/hosted/billing/stripe-appearance";

describe("Stripe appearance", () => {
	test("maps light and dark theme snapshots", () => {
		const light = stripeAppearanceForTheme(false);
		const dark = stripeAppearanceForTheme(true);
		expect(light.theme).toBe("stripe");
		expect(dark.theme).toBe("night");
		expect(light.variables?.colorBackground).toBe("oklch(0.985 0.0025 95)");
		expect(light.variables?.colorText).toBe("oklch(0.235 0.008 95)");
		expect(dark.variables?.colorBackground).toBe("oklch(0.175 0.004 95)");
		expect(dark.variables?.colorText).toBe("oklch(0.92 0.004 95)");
		expect(light.variables?.colorBackground).not.toBe(dark.variables?.colorBackground);
		expect(light.variables?.fontSizeBase).toBe("16px");
		expect(light.rules?.[".Input"]?.fontSize).toBe("16px");
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
