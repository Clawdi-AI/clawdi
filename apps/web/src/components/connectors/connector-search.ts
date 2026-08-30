import { searchExcerpt } from "@/lib/search-highlight";

interface SearchableConnector {
	name: string;
	display_name: string;
	description: string;
}

export function connectorSearchSupportingText(
	connector: SearchableConnector,
	query: string,
): string {
	const phrase = query.trim().toLowerCase();
	if (
		phrase &&
		connector.name.toLowerCase().includes(phrase) &&
		connector.name.toLowerCase() !== connector.display_name.toLowerCase()
	) {
		return `Slug: ${connector.name}`;
	}
	const description = connector.description.trim();
	if (description && phrase && description.toLowerCase().includes(phrase)) {
		return searchExcerpt(description, query, 160);
	}
	return description || `Slug: ${connector.name}`;
}
