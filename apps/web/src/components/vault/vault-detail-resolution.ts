import type { components } from "@/lib/api-schemas";

type VaultSummary = components["schemas"]["VaultResponse"];

/**
 * Legacy slug-only routes have no stable identity. The backend items resolver
 * is called before this helper; this final exact-match fence prevents a list
 * response from ever choosing whichever same-slug Vault happened to sort first.
 */
export function resolveLegacyVaultSummary(
	vaults: readonly VaultSummary[],
	slug: string,
): VaultSummary | null {
	const exactMatches = vaults.filter((vault) => vault.slug === slug);
	if (exactMatches.length > 1) {
		throw new Error(
			`Multiple visible Vaults use the slug "${slug}". Open the Vault from its card to use its stable identity.`,
		);
	}
	return exactMatches[0] ?? null;
}
