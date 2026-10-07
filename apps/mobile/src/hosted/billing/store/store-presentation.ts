import { formatCents, formatUsdExact } from "@clawdi/shared/view";
import type { TranslationKey } from "@/lib/i18n/en";
import type { PurchaseOutcome } from "@/platform/store/purchase-flow";
import type { PurchaseErrorCode } from "@/platform/store/store-error";

/** One credit is one Wallet USD. Converts our own `$1,234.56` display into credit units. */
function creditDisplay(usdDisplay: string, unit: string): string {
	return usdDisplay === "—" ? usdDisplay : `${usdDisplay.replace("$", "")} ${unit}`;
}

/** Exact decimal Wallet USD as credits, e.g. `42.50 credits`. */
export function formatCredits(usd: string, unit: string): string {
	return creditDisplay(formatUsdExact(usd), unit);
}

export function formatCreditCents(cents: number, unit: string): string {
	return creditDisplay(formatCents(cents), unit);
}

/** Wallet credits are USD-denominated; other currencies have no credit equivalent. */
export function creditPrice(
	item: { price_cents?: number | null; currency: string },
	unit: string,
): string | null {
	const cents = item.price_cents;
	if (cents == null || !Number.isSafeInteger(cents) || cents < 0) return null;
	return item.currency.toLowerCase() === "usd" ? formatCreditCents(cents, unit) : null;
}

/** Signed transaction amount from the shared presentation, as credits. */
export function signedCredits(signedUsdDisplay: string, unit: string): string {
	return creditDisplay(signedUsdDisplay, unit);
}

export type StoreNotice = Readonly<{
	key: TranslationKey;
	tone: "success" | "neutral" | "warning";
	/** The Wallet balance may have changed. */
	refresh: boolean;
}>;

/** A null notice means the user dismissed the Paywall without buying. */
export function purchaseOutcomeNotice(
	outcome: Pick<PurchaseOutcome, "status"> & { attempt: Pick<PurchaseOutcome["attempt"], "state"> },
	failure: PurchaseErrorCode | null,
): StoreNotice | null {
	switch (outcome.status) {
		case "funding_applied":
			return { key: "store.fundingApplied", tone: "success", refresh: true };
		case "submitted":
			return { key: "store.submitted", tone: "neutral", refresh: true };
		case "pending":
			return { key: "store.processing", tone: "neutral", refresh: true };
		case "terminal":
			return outcome.attempt.state === "reconciliation_required"
				? { key: "store.reviewRequired", tone: "warning", refresh: true }
				: { key: "store.notCompleted", tone: "neutral", refresh: true };
		case "cancelled":
			return failure ? purchaseErrorNotice(failure) : null;
	}
}

export function purchaseErrorNotice(code: PurchaseErrorCode): StoreNotice {
	const notice = (key: TranslationKey, tone: StoreNotice["tone"] = "warning"): StoreNotice => ({
		key,
		tone,
		refresh: false,
	});
	switch (code) {
		case "payment_pending":
			return notice("store.paymentPending", "neutral");
		case "purchase_unconfirmed":
		case "store_operation_timeout":
		case "store_request_failed":
			return { key: "store.unconfirmed", tone: "warning", refresh: true };
		case "purchase_pending":
			return notice("store.purchaseInProgress", "neutral");
		case "open_refund_debt":
			return notice("store.refundDebt");
		case "store_offering_unavailable":
		case "paywall_unavailable":
			return notice("store.paywallUnavailable");
		case "account_changed":
			return notice("store.accountChanged");
		case "store_purchases_disabled":
		case "store_configuration_missing":
		case "store_identity_unavailable":
		case "store_identity_tombstoned":
		case "identity_mismatch":
			return notice("store.unavailable", "neutral");
		default:
			return notice("store.failed");
	}
}
