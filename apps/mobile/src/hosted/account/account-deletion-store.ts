import type { StoreComputeSlot } from "@clawdi/shared/api";
import { type AccountDeletionStoreNotice, accountDeletionStoreNotice } from "@clawdi/shared/view";

type AccountSubscriptionRows = Parameters<typeof accountDeletionStoreNotice>[0];

/**
 * The shared deletion rule (#1767) over mobile data: the subscriptions list plus the
 * bootstrap `compute_slot`, whose live contract may not be listed yet (for example an
 * unbound slot after a restore). Without the list only a renewable slot can name a store.
 */
export function mobileAccountDeletionStoreNotice(
	rows: AccountSubscriptionRows,
	complete: boolean,
	slot: StoreComputeSlot | null | undefined,
): AccountDeletionStoreNotice {
	const slotRows =
		slot && !slot.available && slot.store_management
			? [{ funding_source: "store" as const, store_management: slot.store_management }]
			: [];
	if (!rows) return accountDeletionStoreNotice(slotRows.length ? slotRows : null, false);
	return accountDeletionStoreNotice([...rows, ...slotRows], complete);
}
