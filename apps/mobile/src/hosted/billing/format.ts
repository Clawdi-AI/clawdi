import type { DeployComponents } from "@clawdi/shared/api";

export type Subscription = DeployComponents["schemas"]["V2ComputeSubscriptionListItem"];
export type Transaction = DeployComponents["schemas"]["V2WalletTransactionItemResponse"];

export function uniqueBillingItems<Item>(
	items: readonly Item[],
	id: (item: Item) => string,
): Item[] {
	return [...new Map(items.map((item) => [id(item), item])).values()];
}
export type Wallet = DeployComponents["schemas"]["V2WalletResponse"];
