import type { components } from "@/lib/api-schemas";

type VaultSummary = components["schemas"]["VaultResponse"];

export function vaultDetailSearch(vault: VaultSummary): { vault: string } {
	return { vault: vault.id };
}

export function selectVaultForDetail(
	vaults: VaultSummary[],
	slug: string,
	vaultId?: string,
): VaultSummary | null {
	if (vaultId) {
		return vaults.find((vault) => vault.id === vaultId && vault.slug === slug) ?? null;
	}
	return vaults.find((vault) => vault.slug === slug) ?? null;
}
