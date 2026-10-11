import type { DeployComponents } from "@clawdi/shared/api";

export type Subscription = DeployComponents["schemas"]["V2ComputeSubscriptionListItem"];
export type Transaction = DeployComponents["schemas"]["V2WalletTransactionItemResponse"];

export function uniqueBillingItems<Item>(
	items: readonly Item[],
	id: (item: Item) => string,
): Item[] {
	return [...new Map(items.map((item) => [id(item), item])).values()];
}

export function validSubscriptionId(value: string | undefined): value is string {
	return typeof value === "string" && /^csub_[A-Za-z0-9]+$/.test(value);
}
