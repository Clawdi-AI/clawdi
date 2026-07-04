import {
	AUTORELOAD_AMOUNT_MAX_CENTS,
	AUTORELOAD_AMOUNT_MIN_CENTS,
	AUTORELOAD_THRESHOLD_MIN_CREDITS,
} from "@/hosted/billing/wallet/wallet-constants";

export interface AutoReloadFormInput {
	amount: string;
	threshold: string;
	cap: string;
	pointsPerUsd: number;
}

export interface AutoReloadFormState {
	amountCents: number;
	thresholdCredits: number;
	capCents: number;
	amountValid: boolean;
	thresholdValid: boolean;
	capValid: boolean;
	formValid: boolean;
}

function centsFromDollars(value: string): number {
	return Math.round(Number(value) * 100);
}

export function autoReloadFormState({
	amount,
	threshold,
	cap,
	pointsPerUsd,
}: AutoReloadFormInput): AutoReloadFormState {
	const amountCents = centsFromDollars(amount);
	const thresholdCredits = Math.round(Number(threshold) * pointsPerUsd);
	const capCents = cap.trim() === "" ? Number.NaN : centsFromDollars(cap);

	const amountValid =
		amountCents >= AUTORELOAD_AMOUNT_MIN_CENTS && amountCents <= AUTORELOAD_AMOUNT_MAX_CENTS;
	const thresholdValid = thresholdCredits >= AUTORELOAD_THRESHOLD_MIN_CREDITS;
	// 0 = no cap; any positive value is a cap. Blank / negative / non-numeric is invalid.
	const capValid = Number.isFinite(capCents) && capCents >= 0;
	const formValid = amountValid && thresholdValid && capValid;

	return {
		amountCents,
		thresholdCredits,
		capCents,
		amountValid,
		thresholdValid,
		capValid,
		formValid,
	};
}
