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
