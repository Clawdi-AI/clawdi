/**
 * Money + credits formatters for the billing surfaces.
 *
 * Convention: `1 USD = points_per_usd credits` (default 1000). The hosted API
 * tracks the wallet in credits and subscriptions in cents. Display shows both
 * where it helps.
 */

const USD = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

const USD_COMPACT = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 0,
	maximumFractionDigits: 2,
});

const CREDITS = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 0,
});

const DECIMAL_CREDITS = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** Cents → "$19.00". */
export function formatCents(cents: number): string {
	return USD.format(cents / 100);
}

/** Cents → "$19" when whole, else "$19.50". For prices/headlines. */
export function formatCentsCompact(cents: number): string {
	return USD_COMPACT.format(cents / 100);
}

/** Dollars → "$10.00". */
export function formatUsd(dollars: number): string {
	return USD.format(dollars);
}

/** Credits → "1,000 credits" (no decimals — credits are integers). */
export function formatCredits(credits: number): string {
	return `${CREDITS.format(Math.round(credits))} credits`;
}

/**
 * Decimal-string credits → a grouped display without rounding through a
 * JavaScript number. Stripe wallet quotes use decimal strings so the debit
 * shown before confirmation stays exact.
 */
export function formatExactCredits(credits: string): string {
	const match = DECIMAL_CREDITS.exec(credits.trim());
	if (!match) return "— credits";
	const [, sign, rawWhole, rawFraction] = match;
	const whole = rawWhole.replace(/^0+(?=\d)/, "");
	const fraction = rawFraction?.replace(/0+$/, "") ?? "";
	const normalizedSign = whole === "0" && !fraction ? "" : sign;
	const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${normalizedSign}${groupedWhole}${fraction ? `.${fraction}` : ""} credits`;
}

/** Credits → USD string using the wallet's conversion rate. */
export function creditsToUsd(credits: number, pointsPerUsd: number): string {
	if (!pointsPerUsd) return USD.format(0);
	return USD.format(credits / pointsPerUsd);
}

/** USD dollars → credits (integer), using the wallet's conversion rate. */
export function usdToCredits(dollars: number, pointsPerUsd: number): number {
	return Math.round(dollars * pointsPerUsd);
}

/** "$57 / 3 mo" style term label. */
export function billingTermLabel(months: number): string {
	if (months === 1) return "Monthly";
	if (months === 3) return "Quarterly";
	if (months === 12) return "Annual";
	return `${months} months`;
}

/** Short billing-term suffix for a price, e.g. "/mo", "/qtr", "/yr". */
export function billingTermSuffix(months: number): string {
	if (months === 1) return "/mo";
	if (months === 3) return "/qtr";
	if (months === 12) return "/yr";
	return `/${months}mo`;
}
