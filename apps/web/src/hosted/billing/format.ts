/** USD formatters for the hosted billing surfaces. */

const USD = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

const DECIMAL_USD = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** Cents → "$19.00". */
export function formatCents(cents: number): string {
	return formatUsd(cents / 100);
}

/** Dollars → "$10.00". */
export function formatUsd(dollars: number): string {
	if (!Number.isFinite(dollars)) return "—";
	if (dollars !== 0 && Math.abs(dollars) < 0.01) {
		return `${dollars < 0 ? "-" : ""}<$0.01`;
	}
	return USD.format(dollars);
}

/**
 * Decimal-string USD → an exact grouped display without rounding through a
 * JavaScript number. Non-zero sub-cent values use a visible floor so usage
 * never appears as "$0.00".
 */
export function formatUsdExact(dollars: string): string {
	const match = DECIMAL_USD.exec(dollars.trim());
	if (!match) return "—";
	const [, sign, rawWhole, rawFraction] = match;
	const whole = rawWhole.replace(/^0+(?=\d)/, "");
	const fraction = rawFraction?.replace(/0+$/, "") ?? "";
	const isZero = whole === "0" && !fraction;
	const normalizedSign = isZero || sign === "+" ? "" : sign;
	const firstTwoFractionDigits = fraction.slice(0, 2).padEnd(2, "0");
	if (!isZero && whole === "0" && firstTwoFractionDigits === "00") {
		return `${normalizedSign}<$0.01`;
	}
	const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	const displayFraction = fraction.padEnd(2, "0");
	return `${normalizedSign}$${groupedWhole}.${displayFraction}`;
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
