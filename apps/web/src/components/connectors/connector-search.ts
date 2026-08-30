import { searchExcerpt, searchTerms } from "@/lib/search-highlight";

interface SearchableConnector {
	name: string;
	display_name: string;
	description: string;
}

export function connectorSearchSupportingText(
	connector: SearchableConnector,
	query: string,
): string {
	const terms = searchTerms(query).map((term) => term.toLocaleLowerCase());
	const title = connector.display_name.toLocaleLowerCase();
	const supportingTerms = terms.filter((term) => !title.includes(term));
	const relevantTerms = supportingTerms.length > 0 ? supportingTerms : terms;
	if (
		relevantTerms.some((term) => connector.name.toLocaleLowerCase().includes(term)) &&
		connector.name.toLocaleLowerCase() !== title
	) {
		return `Slug: ${connector.name}`;
	}
	const description = connector.description.trim();
	if (description && relevantTerms.some((term) => description.toLocaleLowerCase().includes(term))) {
		return searchExcerpt(description, query, 160);
	}
	return description || `Slug: ${connector.name}`;
}
