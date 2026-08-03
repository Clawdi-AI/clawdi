import type { components } from "@/lib/api-schemas";
import { type ResourceNavigationOrigin, resourceOriginSearch } from "@/lib/resource-navigation";

type VaultSummary = components["schemas"]["VaultResponse"];

export function vaultDetailSearch(
	vault: VaultSummary,
	origin?: ResourceNavigationOrigin | null,
): Record<string, string> & { vault: string } {
	return { vault: vault.id, ...resourceOriginSearch(origin) };
}
