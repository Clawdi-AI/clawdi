import type { Appearance, StripeCheckoutElementsSdkOptions } from "@stripe/stripe-js";
import { useEffect, useState } from "react";

type CheckoutAppearance = NonNullable<
	NonNullable<StripeCheckoutElementsSdkOptions["elementsOptions"]>["appearance"]
>;

const DARK_FALLBACK_THEME = {
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

const LIGHT_FALLBACK_THEME = {
	background: "oklch(0.985 0.0025 95)",
	border: "oklch(0.91 0.005 95)",
	destructive: "oklch(0.55 0.19 27)",
	foreground: "oklch(0.235 0.008 95)",
	input: "oklch(0.87 0.006 95)",
	muted: "oklch(0.955 0.004 95)",
	mutedForeground: "oklch(0.51 0.008 95)",
	primary: "oklch(0.6171 0.1375 39.0427)",
	radius: "0.625rem",
};

export function stripeAppearanceForTheme(
	isDark: boolean,
	token: (name: string, fallback: string) => string = (_name, fallback) => fallback,
): Appearance & CheckoutAppearance {
	const fallback = isDark ? DARK_FALLBACK_THEME : LIGHT_FALLBACK_THEME;
	return {
		theme: isDark ? "night" : "stripe",
		variables: {
			borderRadius: token("--radius", fallback.radius),
			colorBackground: token("--background", fallback.background),
			colorDanger: token("--destructive", fallback.destructive),
			colorIconTab: token("--muted-foreground", fallback.mutedForeground),
			colorIconTabSelected: token("--primary", fallback.primary),
			colorPrimary: token("--primary", fallback.primary),
			colorText: token("--foreground", fallback.foreground),
			colorTextPlaceholder: token("--muted-foreground", fallback.mutedForeground),
			colorTextSecondary: token("--muted-foreground", fallback.mutedForeground),
			fontFamily: token("--font-sans", '"Geist Sans", sans-serif'),
			fontSizeBase: "16px",
			spacingUnit: "4px",
		},
		rules: {
			".Block": {
				backgroundColor: token("--muted", fallback.muted),
				borderColor: token("--border", fallback.border),
			},
			".Input": {
				backgroundColor: token("--background", fallback.background),
				borderColor: token("--input", fallback.input),
				boxShadow: "none",
				fontSize: "16px",
			},
			".Input:focus": {
				borderColor: token("--primary", fallback.primary),
				boxShadow: "none",
			},
			".Tab": {
				backgroundColor: token("--muted", fallback.muted),
				borderColor: token("--border", fallback.border),
				boxShadow: "none",
			},
			".Tab--selected": {
				borderColor: token("--primary", fallback.primary),
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
