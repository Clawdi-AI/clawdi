import type { WalletLedgerEntry } from "@/hosted/billing/contracts";

export const PENDING_TOP_UP_STORAGE_KEY = "clawdi.wallet.pending-top-up";
export const TOP_UP_CREDIT_RECHECK_INTERVAL_MS = 3_000;
export const TOP_UP_CREDIT_TIMEOUT_MS = 30_000;

export type PendingTopUpProviderStatus = "succeeded" | "processing" | "unknown";

export interface PendingTopUpCredit {
	providerStatus: PendingTopUpProviderStatus;
	amountCents: number | null;
	paymentStartedAtMs: number;
	checkStartedAtMs: number;
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "removeItem" | "setItem">;

function isPositiveTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isAmountCents(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

function isProviderStatus(value: unknown): value is PendingTopUpProviderStatus {
	return value === "succeeded" || value === "processing" || value === "unknown";
}

function isPendingTopUpCredit(value: unknown): value is PendingTopUpCredit {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		isProviderStatus(candidate.providerStatus) &&
		isAmountCents(candidate.amountCents) &&
		isPositiveTimestamp(candidate.paymentStartedAtMs) &&
		isPositiveTimestamp(candidate.checkStartedAtMs)
	);
}

export function readPendingTopUpCredit(storage: ReadableStorage): PendingTopUpCredit | null {
	try {
		const stored = storage.getItem(PENDING_TOP_UP_STORAGE_KEY);
		if (!stored) return null;
		const parsed: unknown = JSON.parse(stored);
		return isPendingTopUpCredit(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function writePendingTopUpCredit(
	storage: WritableStorage,
	pending: PendingTopUpCredit,
): void {
	try {
		storage.setItem(PENDING_TOP_UP_STORAGE_KEY, JSON.stringify(pending));
	} catch {
		// The in-memory notice still keeps this visit honest when storage is unavailable.
	}
}

export function clearPendingTopUpCredit(storage: WritableStorage): void {
	try {
		storage.removeItem(PENDING_TOP_UP_STORAGE_KEY);
	} catch {
		// Nothing else depends on storage cleanup succeeding.
	}
}

function exactUsdCents(value: string): number | null {
	const match = /^\+?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
	if (!match) return null;
	const whole = Number(match[1]);
	const fraction = Number((match[2] ?? "").padEnd(2, "0"));
	if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) return null;
	const cents = whole * 100 + fraction;
	return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * A provider success becomes a completed Wallet top-up only when the Wallet
 * ledger exposes the matching applied credit. Stripe acceptance alone is not
 * evidence that the webhook-backed Wallet projection has converged.
 */
export function pendingTopUpCreditIsApplied(
	pending: PendingTopUpCredit,
	entries: readonly WalletLedgerEntry[],
): boolean {
	return entries.some((entry) => {
		if (entry.status !== "applied") return false;
		if (entry.operation !== "topup" && entry.operation !== "invoice") return false;
		const createdAtMs = Date.parse(entry.created_at);
		if (!Number.isFinite(createdAtMs) || createdAtMs < pending.paymentStartedAtMs - 60_000) {
			return false;
		}
		return pending.amountCents === null || exactUsdCents(entry.amount_usd) === pending.amountCents;
	});
}
