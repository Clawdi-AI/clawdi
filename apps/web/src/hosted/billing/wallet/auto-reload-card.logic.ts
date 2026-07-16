import type { WalletAutoReloadRequest, WalletState } from "@/hosted/billing/contracts";
import {
	BillingApiError,
	billingErrorDetail,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import {
	AUTORELOAD_AMOUNT_MAX_CENTS,
	AUTORELOAD_AMOUNT_MIN_CENTS,
	AUTORELOAD_THRESHOLD_MIN_CREDITS,
} from "@/hosted/billing/wallet/wallet-constants";

export interface AutoReloadDraft {
	enabled: boolean;
	amount: string;
	threshold: string;
	cap: string;
}

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

export interface AutoReloadSaveError {
	title: string;
	description: string;
	field: "amount" | "threshold" | "cap" | null;
	requiresPaymentMethod: boolean;
}

function dollars(value: number): string {
	return String(Math.round(value * 100) / 100);
}

function dollarsFromInput(value: string): number | null {
	const normalized = value.trim();
	if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return null;
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

export function autoReloadFormState({
	amount,
	threshold,
	cap,
	pointsPerUsd,
}: AutoReloadFormInput): AutoReloadFormState {
	const amountDollars = dollarsFromInput(amount);
	const thresholdDollars = dollarsFromInput(threshold);
	const capDollars = dollarsFromInput(cap);
	const amountCents = amountDollars === null ? Number.NaN : Math.round(amountDollars * 100);
	const thresholdCredits =
		thresholdDollars === null ? Number.NaN : Math.round(thresholdDollars * pointsPerUsd);
	const capCents = capDollars === null ? Number.NaN : Math.round(capDollars * 100);

	const amountValid =
		Number.isFinite(amountCents) &&
		amountCents >= AUTORELOAD_AMOUNT_MIN_CENTS &&
		amountCents <= AUTORELOAD_AMOUNT_MAX_CENTS;
	const thresholdValid =
		Number.isFinite(thresholdCredits) && thresholdCredits >= AUTORELOAD_THRESHOLD_MIN_CREDITS;
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

export function autoReloadThresholdMinimumCents(pointsPerUsd: number): number {
	return Math.ceil((AUTORELOAD_THRESHOLD_MIN_CREDITS / pointsPerUsd) * 100);
}

export function autoReloadDraftFromWallet(wallet: WalletState): AutoReloadDraft {
	const pointsPerUsd = wallet.points_per_usd || 1000;
	return {
		enabled: wallet.auto_reload_enabled,
		threshold: dollars(wallet.auto_reload_threshold_credits / pointsPerUsd),
		amount: dollars(wallet.auto_reload_amount_cents / 100),
		cap: dollars(wallet.auto_reload_monthly_cap_cents / 100),
	};
}

export function autoReloadRequest(
	draft: AutoReloadDraft,
	pointsPerUsd: number,
): WalletAutoReloadRequest | null {
	const state = autoReloadFormState({
		amount: draft.amount,
		threshold: draft.threshold,
		cap: draft.cap,
		pointsPerUsd,
	});
	if (!state.formValid) return null;

	return {
		auto_reload_enabled: draft.enabled,
		auto_reload_threshold_credits: state.thresholdCredits,
		auto_reload_amount_cents: state.amountCents,
		auto_reload_monthly_cap_cents: state.capCents,
	};
}

export function autoReloadDraftIsDirty(
	draft: AutoReloadDraft,
	baseline: AutoReloadDraft,
	pointsPerUsd: number,
): boolean {
	const draftRequest = autoReloadRequest(draft, pointsPerUsd);
	const baselineRequest = autoReloadRequest(baseline, pointsPerUsd);
	if (!draftRequest || !baselineRequest) return JSON.stringify(draft) !== JSON.stringify(baseline);

	return (
		draftRequest.auto_reload_enabled !== baselineRequest.auto_reload_enabled ||
		draftRequest.auto_reload_threshold_credits !== baselineRequest.auto_reload_threshold_credits ||
		draftRequest.auto_reload_amount_cents !== baselineRequest.auto_reload_amount_cents ||
		draftRequest.auto_reload_monthly_cap_cents !== baselineRequest.auto_reload_monthly_cap_cents
	);
}

export function autoReloadSaveError(error: unknown): AutoReloadSaveError {
	const detail = error instanceof BillingApiError ? error.detail : "";
	const code = billingErrorDetail(error)?.code;
	const signal = `${typeof code === "string" ? code : ""} ${detail}`.toLowerCase();

	if (signal.includes("payment method") || signal.includes("payment_method")) {
		return {
			title: "Add a card before enabling auto-reload",
			description: "Complete a manual top-up to save a card, then save these changes again.",
			field: null,
			requiresPaymentMethod: true,
		};
	}
	if (signal.includes("threshold")) {
		return {
			title: "Check the balance threshold",
			description: "Enter a threshold at or above the minimum shown below, then save again.",
			field: "threshold",
			requiresPaymentMethod: false,
		};
	}
	if (signal.includes("monthly cap") || signal.includes("monthly_cap")) {
		return {
			title: "Check the monthly cap",
			description: "Enter 0 for no cap or a positive dollar amount, then save again.",
			field: "cap",
			requiresPaymentMethod: false,
		};
	}
	if (signal.includes("auto reload amount") || signal.includes("auto_reload_amount")) {
		return {
			title: "Check the reload amount",
			description: "Enter an amount from $5 to $500, then save again.",
			field: "amount",
			requiresPaymentMethod: false,
		};
	}

	return {
		title: "Couldn’t save auto-reload",
		description: normalizeBillingError(error),
		field: null,
		requiresPaymentMethod: false,
	};
}
