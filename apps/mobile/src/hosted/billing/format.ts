import type { DeployComponents } from "@clawdi/shared/api";

export type Subscription = DeployComponents["schemas"]["V2ComputeSubscriptionListItem"];
export type Transaction = DeployComponents["schemas"]["V2WalletTransactionItemResponse"];
type SubscriptionPage = DeployComponents["schemas"]["V2ComputeSubscriptionListResponse"];
type CursorPage = Pick<SubscriptionPage, "has_more" | "next_cursor">;

/** Preserve the server's decimal USD amount, including sub-cent precision. */
export function exactUsd(amount: string | null | undefined): string | null {
	return typeof amount === "string" && /^-?\d+(?:\.\d+)?$/.test(amount) ? `USD ${amount}` : null;
}

export function subscriptionPrice(
	item: Pick<Subscription, "price_cents" | "currency">,
): string | null {
	if (item.price_cents == null || !Number.isSafeInteger(item.price_cents) || item.price_cents < 0)
		return null;
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency: item.currency }).format(
			item.price_cents / 100,
		);
	} catch {
		return null;
	}
}

export function nextBillingCursor(
	page: CursorPage,
	pages: readonly CursorPage[],
): string | undefined {
	const cursor = page.next_cursor;
	if (!page.has_more || !cursor?.trim()) return undefined;
	return pages.slice(0, -1).some((previous) => previous.next_cursor === cursor)
		? undefined
		: cursor;
}

export function uniqueBillingItems<Item>(
	items: readonly Item[],
	id: (item: Item) => string,
): Item[] {
	return [...new Map(items.map((item) => [id(item), item])).values()];
}

export function validSubscriptionId(value: string | undefined): value is string {
	return typeof value === "string" && /^csub_[A-Za-z0-9]+$/.test(value);
}
