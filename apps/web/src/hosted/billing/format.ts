/** USD formatters for the hosted billing surfaces. */

const USD = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

const DECIMAL_USD = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const USD_INPUT = /^(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

type DecimalParts = {
	units: bigint;
	scale: number;
};

function decimalParts(value: string): DecimalParts | null {
	if (!value || value.length > 64) return null;
	const match = DECIMAL_USD.exec(value);
	if (!match) return null;
	const sign = match[1] === "-" ? -1n : 1n;
	const whole = match[2] ?? "0";
	const fraction = match[3] ?? "";
	return {
		units: sign * BigInt(`${whole}${fraction}`),
		scale: fraction.length,
	};
}

function scaledUnits(parts: DecimalParts, scale: number): bigint {
	return parts.units * 10n ** BigInt(scale - parts.scale);
}

function decimalString(units: bigint, scale: number): string {
	const negative = units < 0n;
	const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
	const whole = scale === 0 ? digits : digits.slice(0, -scale);
	const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
	return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Canonicalize a finite fixed-point decimal without converting through Number. */
export function canonicalDecimal(value: unknown): string | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	if (typeof value === "number" && !Number.isFinite(value)) return null;
	const parts = decimalParts(String(value));
	return parts ? decimalString(parts.units, parts.scale) : null;
}

/** Compare two fixed-point decimals exactly. */
export function compareDecimals(left: string, right: string): number | null {
	const leftParts = decimalParts(left);
	const rightParts = decimalParts(right);
	if (!leftParts || !rightParts) return null;
	const scale = Math.max(leftParts.scale, rightParts.scale);
	const difference = scaledUnits(leftParts, scale) - scaledUnits(rightParts, scale);
	return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** Add two fixed-point decimals exactly. */
export function addDecimals(left: string, right: string): string | null {
	const leftParts = decimalParts(left);
	const rightParts = decimalParts(right);
	if (!leftParts || !rightParts) return null;
	const scale = Math.max(leftParts.scale, rightParts.scale);
	return decimalString(scaledUnits(leftParts, scale) + scaledUnits(rightParts, scale), scale);
}

/** Subtract two fixed-point decimals exactly. */
export function subtractDecimals(left: string, right: string): string | null {
	const leftParts = decimalParts(left);
	const rightParts = decimalParts(right);
	if (!leftParts || !rightParts) return null;
	const scale = Math.max(leftParts.scale, rightParts.scale);
	return decimalString(scaledUnits(leftParts, scale) - scaledUnits(rightParts, scale), scale);
}

/** Return the exact positive magnitude, or null for zero, positive, or invalid input. */
export function negativeDecimalMagnitude(value: string): string | null {
	const parts = decimalParts(value);
	return parts && parts.units < 0n ? decimalString(-parts.units, parts.scale) : null;
}

/** Return a bounded percentage for presentation without floating-point money math. */
export function decimalRatioPercent(value: string, maximum: string): number {
	const valueParts = decimalParts(value);
	const maximumParts = decimalParts(maximum);
	if (!valueParts || !maximumParts || valueParts.units <= 0n || maximumParts.units <= 0n) {
		return 0;
	}
	const scale = Math.max(valueParts.scale, maximumParts.scale);
	const numerator = scaledUnits(valueParts, scale);
	const denominator = scaledUnits(maximumParts, scale);
	const basisPoints = (numerator * 10_000n) / denominator;
	return Number(basisPoints > 10_000n ? 10_000n : basisPoints) / 100;
}

function incrementDecimalDigits(digits: string): string {
	const incremented = [...digits];
	for (let index = incremented.length - 1; index >= 0; index -= 1) {
		const digit = incremented[index];
		if (digit === "9") {
			incremented[index] = "0";
			continue;
		}
		incremented[index] = String.fromCharCode(digit.charCodeAt(0) + 1);
		return incremented.join("");
	}
	return `1${incremented.join("")}`;
}

/** Cents → "$19.00". */
export function formatCents(cents: number): string {
	return formatUsd(cents / 100);
}

/** Minor currency units -> a localized amount, with a safe ISO-code fallback. */
export function formatCurrencyCents(cents: number, currency: string): string {
	if (currency.toLowerCase() === "usd") return formatCents(cents);
	try {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency,
		}).format(cents / 100);
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
	}
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
 * Decimal-string USD → an exactly rounded, grouped cents display without
 * converting the amount to a JavaScript number. Non-zero sub-cent values use
 * a visible floor so usage never appears as "$0.00".
 */
export function formatUsdExact(dollars: string): string {
	const match = DECIMAL_USD.exec(dollars.trim());
	if (!match) return "—";
	const [, sign, rawWhole, rawFraction] = match;
	const whole = rawWhole.replace(/^0+(?=\d)/, "");
	const fraction = rawFraction ?? "";
	const isZero = whole === "0" && !/[1-9]/.test(fraction);
	const normalizedSign = isZero || sign !== "-" ? "" : "-";
	const firstTwoFractionDigits = fraction.slice(0, 2).padEnd(2, "0");
	if (!isZero && whole === "0" && firstTwoFractionDigits === "00") {
		return `${normalizedSign}<$0.01`;
	}

	const unroundedCents = `${whole}${firstTwoFractionDigits}`;
	const roundedCents =
		(fraction[2] ?? "0") >= "5" ? incrementDecimalDigits(unroundedCents) : unroundedCents;
	const roundedWhole = roundedCents.slice(0, -2);
	const displayFraction = roundedCents.slice(-2);
	const groupedWhole = roundedWhole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${normalizedSign}$${groupedWhole}.${displayFraction}`;
}

/** Parse a canonical positive USD form value without floating-point conversion. */
export function usdInputToCents(value: string): number | null {
	if (!value || value.length > 17) return null;
	const match = USD_INPUT.exec(value);
	if (!match) return null;
	const separator = value.indexOf(".");
	const whole = separator === -1 ? value : value.slice(0, separator);
	const fraction = (match[1] ?? "").padEnd(2, "0");
	const cents = BigInt(whole) * 100n + BigInt(fraction);
	return cents > 0n && cents <= MAX_SAFE_CENTS ? Number(cents) : null;
}

/** Parse a positive backend USD decimal when all precision beyond cents is zero. */
export function persistedUsdToCents(value: string): number | null {
	const parts = decimalParts(value);
	if (!parts || parts.units <= 0n) return null;
	let cents: bigint;
	if (parts.scale <= 2) {
		cents = parts.units * 10n ** BigInt(2 - parts.scale);
	} else {
		const subcentScale = 10n ** BigInt(parts.scale - 2);
		if (parts.units % subcentScale !== 0n) return null;
		cents = parts.units / subcentScale;
	}
	return cents <= MAX_SAFE_CENTS ? Number(cents) : null;
}

/** Round a positive exact USD shortfall up to whole dollars and return cents. */
export function wholeDollarTopUpCents(
	shortfallUsd: string | null,
	minimumCents: number,
	maximumCents: number,
): number | null {
	if (shortfallUsd === null) return null;
	const parts = decimalParts(shortfallUsd);
	if (!parts || parts.units <= 0n) return null;
	const divisor = 10n ** BigInt(parts.scale);
	const wholeDollars = (parts.units + divisor - 1n) / divisor;
	const cents = wholeDollars * 100n;
	return Number(
		cents < BigInt(minimumCents)
			? BigInt(minimumCents)
			: cents > BigInt(maximumCents)
				? BigInt(maximumCents)
				: cents,
	);
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
