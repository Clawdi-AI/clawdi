export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 500;

export function searchQueryLength(value: string): number {
	return Array.from(value.trim()).length;
}

export function isSearchQueryReady(value: string): boolean {
	const length = searchQueryLength(value);
	return length >= SEARCH_QUERY_MIN_LENGTH && length <= SEARCH_QUERY_MAX_LENGTH;
}
