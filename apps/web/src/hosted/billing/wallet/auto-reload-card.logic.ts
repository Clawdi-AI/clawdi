import type { WalletAutoReloadRequest } from "@/hosted/billing/contracts";
import {
	BillingApiError,
	billingErrorDetail,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import type { WalletCacheSnapshot } from "@/hosted/billing/wallet/wallet-cache";
import {
	AUTORELOAD_AMOUNT_MAX_CENTS,
	AUTORELOAD_AMOUNT_MIN_CENTS,
	AUTORELOAD_AMOUNT_RANGE_LABEL,
	AUTORELOAD_THRESHOLD_MIN_USD,
} from "@/hosted/billing/wallet/wallet-constants";

export interface AutoReloadDraft {
	enabled: boolean;
	amount: string;
	threshold: string;
	cap: string;
	unlimited: boolean;
}

export interface AutoReloadFormInput {
	amount: string;
	threshold: string;
	cap: string;
	unlimited?: boolean;
}

export interface AutoReloadFormState {
	amountCents: number;
	thresholdUsd: number;
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

export interface AutoReloadStatusSummary {
	label: string;
	tone: "success" | "warning" | "destructive" | "neutral";
	description: string;
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

function periodEndLabel(value: string): string {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(value));
}

export function autoReloadStatusSummary(wallet: WalletCacheSnapshot): AutoReloadStatusSummary {
	switch (wallet.auto_reload_status) {
		case "active":
			return { label: "Active", tone: "success", description: "Auto-reload is ready." };
		case "paused_monthly_limit":
			return {
				label: "Paused",
				tone: "warning",
				description: `Monthly limit reached. Auto-reload resumes ${periodEndLabel(wallet.auto_reload_period_end)}.`,
			};
		case "payment_action_required":
			return {
				label: "Confirmation needed",
				tone: "warning",
				description: "Confirm the pending card payment to finish the reload.",
			};
		case "payment_failed":
			return {
				label: "Payment failed",
				tone: "destructive",
				description: "Update your payment method, then set up auto-reload again.",
			};
		case "blocked_refund":
			return {
				label: "Blocked",
				tone: "destructive",
				description: "A refunded balance must be resolved before auto-reload can run.",
			};
		default:
			return {
				label: "Off",
				tone: "neutral",
				description: "Automatically add funds when your balance is low.",
			};
	}
}

export function autoReloadFormState({
	amount,
	threshold,
	cap,
	unlimited = false,
}: AutoReloadFormInput): AutoReloadFormState {
	const amountDollars = dollarsFromInput(amount);
	const thresholdDollars = dollarsFromInput(threshold);
	const capDollars = dollarsFromInput(cap);
	const amountCents = amountDollars === null ? Number.NaN : Math.round(amountDollars * 100);
	const thresholdUsd = thresholdDollars === null ? Number.NaN : thresholdDollars;
	const capCents = unlimited ? 0 : capDollars === null ? Number.NaN : Math.round(capDollars * 100);

	const amountValid =
		Number.isFinite(amountCents) &&
		amountCents >= AUTORELOAD_AMOUNT_MIN_CENTS &&
		amountCents <= AUTORELOAD_AMOUNT_MAX_CENTS;
	const thresholdValid =
		Number.isFinite(thresholdUsd) && thresholdUsd >= AUTORELOAD_THRESHOLD_MIN_USD;
	const capValid =
		unlimited || (Number.isFinite(capCents) && (!amountValid || capCents >= amountCents));
	const formValid = amountValid && thresholdValid && capValid;

	return {
		amountCents,
		thresholdUsd,
		capCents,
		amountValid,
		thresholdValid,
		capValid,
		formValid,
	};
}

export function autoReloadDraftFromWallet(wallet: WalletCacheSnapshot): AutoReloadDraft {
	const unlimited = wallet.auto_reload_monthly_cap_cents === 0;
	return {
		enabled: wallet.auto_reload_enabled,
		threshold: dollars(Number(wallet.auto_reload_threshold_usd)),
		amount: dollars(wallet.auto_reload_amount_cents / 100),
		cap: dollars(
			(unlimited ? wallet.auto_reload_amount_cents : wallet.auto_reload_monthly_cap_cents) / 100,
		),
		unlimited,
	};
}

export function autoReloadRequest(draft: AutoReloadDraft): WalletAutoReloadRequest | null {
	const state = autoReloadFormState({
		amount: draft.amount,
		threshold: draft.threshold,
		cap: draft.cap,
		unlimited: draft.unlimited,
	});
	if (!state.formValid) return null;

	return {
		auto_reload_enabled: draft.enabled,
		auto_reload_threshold_usd: state.thresholdUsd,
		auto_reload_amount_cents: state.amountCents,
		auto_reload_monthly_cap_cents: state.capCents,
	};
}

export function autoReloadDraftIsDirty(draft: AutoReloadDraft, baseline: AutoReloadDraft): boolean {
	const draftRequest = autoReloadRequest(draft);
	const baselineRequest = autoReloadRequest(baseline);
	if (!draftRequest || !baselineRequest) return JSON.stringify(draft) !== JSON.stringify(baseline);

	return (
		draftRequest.auto_reload_enabled !== baselineRequest.auto_reload_enabled ||
		draftRequest.auto_reload_threshold_usd !== baselineRequest.auto_reload_threshold_usd ||
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
			description: "Set a monthly limit at least as large as one reload, or choose no limit.",
			field: "cap",
			requiresPaymentMethod: false,
		};
	}
	if (signal.includes("auto reload amount") || signal.includes("auto_reload_amount")) {
		return {
			title: "Check the reload amount",
			description: `Enter an amount from ${AUTORELOAD_AMOUNT_RANGE_LABEL}, then save again.`,
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
