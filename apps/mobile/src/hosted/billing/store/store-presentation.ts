import type { StoreComputeReconcileResponse, StoreComputeSlot } from "@clawdi/shared/api";
import { formatCents, formatUsdExact } from "@clawdi/shared/view";
import type { Subscription } from "@/hosted/billing/format";
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
	/** Interpolation values, such as the billing store's name. */
	values?: Readonly<Record<string, string>>;
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

/** The most actionable result of an explicit "Check pending purchases" recovery. */
export function pendingCheckNotice(
	outcomes: readonly Parameters<typeof purchaseOutcomeNotice>[0][],
): StoreNotice {
	const rank: readonly TranslationKey[] = [
		"store.reviewRequired",
		"store.fundingApplied",
		"store.submitted",
		"store.processing",
		"store.notCompleted",
	];
	const notices = outcomes.flatMap((outcome) => purchaseOutcomeNotice(outcome, null) ?? []);
	for (const key of rank) {
		const notice = notices.find((item) => item.key === key);
		if (notice) return notice;
	}
	return { key: "store.noPending", tone: "neutral", refresh: false };
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

/** What a compute subscription purchase is for; drives its result copy. */
export type ComputePurchaseContext = "deploy" | "upgrade" | "change";

/**
 * Result of a compute subscription purchase. `funding_applied` for a deploy is not a
 * notice: the caller continues with admission. A null notice means the Paywall or store
 * sheet was closed without buying, so the draft stays as it was.
 */
export function computePurchaseNotice(
	outcome: Pick<PurchaseOutcome, "status"> & { attempt: Pick<PurchaseOutcome["attempt"], "state"> },
	failure: PurchaseErrorCode | null,
	context: ComputePurchaseContext,
	store: string,
): StoreNotice | null {
	const notice = (key: TranslationKey, tone: StoreNotice["tone"]): StoreNotice => ({
		key,
		tone,
		refresh: true,
		values: { store },
	});
	switch (outcome.status) {
		case "funding_applied":
			return context === "deploy"
				? null
				: notice(
						context === "upgrade" ? "storeCompute.upgraded" : "storeCompute.changed",
						"success",
					);
		case "submitted":
			return notice("storeCompute.submitted", "neutral");
		case "pending":
			return notice("storeCompute.processing", "neutral");
		case "terminal":
			return outcome.attempt.state === "reconciliation_required"
				? notice("store.reviewRequired", "warning")
				: notice("storeCompute.notCompleted", "neutral");
		case "cancelled":
			return failure ? computePurchaseErrorNotice(failure, context, store) : null;
	}
}

export function computePurchaseErrorNotice(
	code: PurchaseErrorCode,
	context: ComputePurchaseContext,
	store: string,
	/** Display time when a blocking earlier attempt expires (`StorePurchaseError.retryAt`). */
	retryAt: string | null = null,
): StoreNotice {
	const values = { store };
	switch (code) {
		case "purchase_pending":
			return retryAt
				? {
						key: "storeCompute.previousPurchasePreparing",
						tone: "neutral",
						refresh: false,
						values: { time: retryAt },
					}
				: { key: "storeCompute.previousPurchasePreparingSoon", tone: "neutral", refresh: false };
		case "payment_pending":
			return {
				key:
					context === "deploy"
						? "storeCompute.waitingForApproval"
						: context === "upgrade"
							? "storeCompute.waitingForApprovalUpgrade"
							: "storeCompute.waitingForApprovalChange",
				tone: "neutral",
				refresh: true,
				values,
			};
		case "store_offering_unavailable":
		case "paywall_unavailable":
			return { key: "storeCompute.unavailable", tone: "warning", refresh: false, values };
		case "purchase_unconfirmed":
		case "store_operation_timeout":
		case "store_request_failed":
			return { key: "storeCompute.unconfirmed", tone: "warning", refresh: true, values };
		case "store_purchases_disabled":
		case "store_configuration_missing":
		case "store_identity_unavailable":
		case "store_identity_tombstoned":
		case "identity_mismatch":
		case "open_refund_debt":
		case "account_changed":
			return purchaseErrorNotice(code);
		default:
			return { key: "storeCompute.failed", tone: "warning", refresh: false, values };
	}
}

/** Restore results, most actionable first; another account's subscription is never moved. */
export function restorePurchasesNotices(
	response: Pick<StoreComputeReconcileResponse, "code" | "results">,
	store: string,
): StoreNotice[] {
	const codes = new Set([response.code, ...(response.results ?? []).map((result) => result.code)]);
	const notices: StoreNotice[] = [];
	if (codes.has("owned_by_other_account"))
		notices.push({
			key: "storeCompute.ownedByOtherAccount",
			tone: "warning",
			refresh: false,
			values: { store },
		});
	if (codes.has("reconciliation_pending"))
		notices.push({ key: "storeCompute.restorePending", tone: "neutral", refresh: true });
	if (response.code === "reconciled" || codes.has("reconciled"))
		notices.push({ key: "storeCompute.restored", tone: "success", refresh: true });
	return notices;
}

/** The live store contract behind a store-funded row; one per account. */
export function storeContractIdForRow(
	item: Pick<Subscription, "deployment_id" | "store_management">,
	slot: StoreComputeSlot | null,
): string | null {
	const management = item.store_management;
	if (!slot || slot.available || !slot.contract_id || !management) return null;
	if (slot.store_management?.product_id !== management.product_id) return null;
	if (slot.agent_id && slot.agent_id !== item.deployment_id) return null;
	return slot.contract_id;
}
