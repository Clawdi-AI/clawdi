import type { Appearance, StripeCheckoutElementsSdkOptions } from "@stripe/stripe-js";
import { useEffect, useState } from "react";

type CheckoutAppearance = NonNullable<
	NonNullable<StripeCheckoutElementsSdkOptions["elementsOptions"]>["appearance"]
>;

const FALLBACK_THEME = {
	background: "oklch(0.175 0.004 95)",
	border: "oklch(0.275 0.005 95)",
	destructive: "oklch(0.62 0.19 27)",
	foreground: "oklch(0.92 0.004 95)",
	input: "oklch(0.33 0.006 95)",
	muted: "oklch(0.245 0.005 95)",
	mutedForeground: "oklch(0.63 0.006 95)",
	primary: "oklch(0.6724 0.1308 38.7559)",
	radius: "0.625rem",
};

export function stripeAppearanceForTheme(
	isDark: boolean,
	token: (name: string, fallback: string) => string = (_name, fallback) => fallback,
): Appearance & CheckoutAppearance {
	return {
		theme: isDark ? "night" : "stripe",
		variables: {
			borderRadius: token("--radius", FALLBACK_THEME.radius),
			colorBackground: token("--background", FALLBACK_THEME.background),
			colorDanger: token("--destructive", FALLBACK_THEME.destructive),
			colorIconTab: token("--muted-foreground", FALLBACK_THEME.mutedForeground),
			colorIconTabSelected: token("--primary", FALLBACK_THEME.primary),
			colorPrimary: token("--primary", FALLBACK_THEME.primary),
			colorText: token("--foreground", FALLBACK_THEME.foreground),
			colorTextPlaceholder: token("--muted-foreground", FALLBACK_THEME.mutedForeground),
			colorTextSecondary: token("--muted-foreground", FALLBACK_THEME.mutedForeground),
			fontFamily: token("--font-sans", '"Geist Sans", sans-serif'),
			spacingUnit: "4px",
		},
		rules: {
			".Block": {
				backgroundColor: token("--muted", FALLBACK_THEME.muted),
				borderColor: token("--border", FALLBACK_THEME.border),
			},
			".Input": {
				backgroundColor: token("--background", FALLBACK_THEME.background),
				borderColor: token("--input", FALLBACK_THEME.input),
				boxShadow: "none",
			},
			".Input:focus": {
				borderColor: token("--primary", FALLBACK_THEME.primary),
				boxShadow: "none",
			},
			".Tab": {
				backgroundColor: token("--muted", FALLBACK_THEME.muted),
				borderColor: token("--border", FALLBACK_THEME.border),
				boxShadow: "none",
			},
			".Tab--selected": {
				borderColor: token("--primary", FALLBACK_THEME.primary),
				boxShadow: "none",
			},
		},
	};
}

export function stripeAppearanceFromTheme(): Appearance & CheckoutAppearance {
	const style =
		typeof window === "undefined" ? null : window.getComputedStyle(document.documentElement);
	const token = (name: string, fallback: string) =>
		style?.getPropertyValue(name).trim() || fallback;
	const isDark =
		typeof document !== "undefined" && document.documentElement.classList.contains("dark");
	return stripeAppearanceForTheme(isDark, token);
}

type ThemeChangeSubscription = (update: () => void) => () => void;

export function watchStripeThemeChanges(
	update: () => void,
	subscribe: ThemeChangeSubscription = (onMutation) => {
		const observer = new MutationObserver(onMutation);
		observer.observe(document.documentElement, {
			attributeFilter: ["class", "style"],
			attributes: true,
		});
		return () => observer.disconnect();
	},
): () => void {
	update();
	return subscribe(update);
}

export function useStripeAppearance(active = true): Appearance & CheckoutAppearance {
	const [appearance, setAppearance] = useState(stripeAppearanceFromTheme);

	useEffect(() => {
		if (!active || typeof MutationObserver === "undefined") return;
		return watchStripeThemeChanges(() => setAppearance(stripeAppearanceFromTheme()));
	}, [active]);

	return appearance;
}
