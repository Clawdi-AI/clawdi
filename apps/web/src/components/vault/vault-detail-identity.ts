import type { components } from "@/lib/api-schemas";

type VaultSummary = components["schemas"]["VaultResponse"];

export function vaultDetailSearch(vault: VaultSummary): { vault: string } {
	return { vault: vault.id };
}
