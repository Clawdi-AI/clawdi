export interface SearchHighlightPart {
	text: string;
	highlighted: boolean;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createSearchHighlighter(query: string) {
	const phrase = query.trim();
	if (!phrase) {
		return (text: string): SearchHighlightPart[] => [{ text, highlighted: false }];
	}

	const pattern = new RegExp(escapeRegExp(phrase), "giu");
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
