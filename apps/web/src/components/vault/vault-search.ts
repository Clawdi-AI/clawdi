import { literalSearchRank } from "@/lib/search-highlight";

interface SearchableVault {
	name: string;
	slug: string;
}

export function vaultSearchRank(vault: SearchableVault, query: string): number | null {
	return literalSearchRank(query, [vault.name, vault.slug]);
}

export function vaultSearchSupportingText(vault: SearchableVault, query: string): string | null {
	const phrase = query.trim().toLowerCase();
	if (
		phrase &&
		vault.slug.toLowerCase().includes(phrase) &&
		vault.slug.toLowerCase() !== vault.name.toLowerCase()
	) {
		return `Slug: ${vault.slug}`;
	}
	return null;
}
