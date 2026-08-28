export interface SearchHighlightPart {
	text: string;
	highlighted: boolean;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchTerms(query: string): string[] {
	const normalized = query.trim();
	if (!normalized) return [];

	const candidates = [normalized, ...(normalized.match(/[\p{L}\p{N}_]+/gu) ?? [])];
	const seen = new Set<string>();
	return candidates
		.filter((term) => term.length > 1 || normalized.length === 1)
		.filter((term) => {
			const key = term.toLocaleLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => b.length - a.length)
		.slice(0, 24);
}

export function createSearchHighlighter(query: string) {
	const terms = searchTerms(query);
	if (terms.length === 0) {
		return (text: string): SearchHighlightPart[] => [{ text, highlighted: false }];
	}

	const pattern = new RegExp(terms.map(escapeRegExp).join("|"), "giu");
	return (text: string): SearchHighlightPart[] => {
		pattern.lastIndex = 0;
		const parts: SearchHighlightPart[] = [];
		let offset = 0;
		for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
			const index = match.index;
			const matched = match[0];
			if (index > offset) parts.push({ text: text.slice(offset, index), highlighted: false });
			parts.push({ text: matched, highlighted: true });
			offset = index + matched.length;
		}
		if (parts.length === 0) return [{ text, highlighted: false }];
		if (offset < text.length) parts.push({ text: text.slice(offset), highlighted: false });
		return parts;
	};
}

export function splitSearchHighlight(text: string, query: string): SearchHighlightPart[] {
	return createSearchHighlighter(query)(text);
}
