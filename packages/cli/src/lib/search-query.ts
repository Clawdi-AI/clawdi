import {
	SEARCH_QUERY_MAX_LENGTH,
	SEARCH_QUERY_MIN_LENGTH,
	searchQueryLength,
} from "@clawdi/shared/consts";

export function requireSearchQuery(value: string, label: string): string {
	const query = value.trim();
	const length = searchQueryLength(query);
	if (length < SEARCH_QUERY_MIN_LENGTH) {
		throw new Error(
			`${label} search query must be at least ${SEARCH_QUERY_MIN_LENGTH} characters.`,
		);
	}
	if (length > SEARCH_QUERY_MAX_LENGTH) {
		throw new Error(`${label} search query must be at most ${SEARCH_QUERY_MAX_LENGTH} characters.`);
	}
	return query;
}
