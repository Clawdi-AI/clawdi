import { literalSearchRank, searchTerms } from "@/lib/search-highlight";

interface SearchableVault {
	name: string;
	slug: string;
}

export function vaultSearchRank(vault: SearchableVault, query: string): number | null {
	return literalSearchRank(query, [vault.name, vault.slug]);
}

export function vaultSearchSupportingText(vault: SearchableVault, query: string): string | null {
	const terms = searchTerms(query).map((term) => term.toLocaleLowerCase());
	const title = vault.name.toLocaleLowerCase();
	const relevantTerms = terms.filter((term) => !title.includes(term));
	if (
		relevantTerms.some((term) => vault.slug.toLocaleLowerCase().includes(term)) &&
		vault.slug.toLocaleLowerCase() !== title
	) {
		return `Slug: ${vault.slug}`;
	}
	return null;
}

export function compareVaultsForCatalog(
	a: SearchableVault & { id: string; item_count?: number },
	b: SearchableVault & { id: string; item_count?: number },
	query: string,
): number {
	const rank = query.trim()
		? (vaultSearchRank(a, query) ?? Number.MAX_SAFE_INTEGER) -
			(vaultSearchRank(b, query) ?? Number.MAX_SAFE_INTEGER)
		: (b.item_count ?? 0) - (a.item_count ?? 0);
	return rank || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
