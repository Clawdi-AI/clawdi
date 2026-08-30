export interface SearchHighlightPart {
	text: string;
	highlighted: boolean;
}

type SearchField = string | null | undefined;

export function searchTerms(query: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const term of query.trim().split(/\s+/u)) {
		if (!term) continue;
		const folded = term.toLocaleLowerCase();
		if (seen.has(folded)) continue;
		seen.add(folded);
		terms.push(term);
	}
	return terms;
}

export function literalSearchRank(
	query: string,
	identityFields: readonly SearchField[],
	supportingFields: readonly SearchField[] = [],
): number | null {
	const phrase = query.trim().toLowerCase();
	if (!phrase) return 0;
	const identity = identityFields.map((field) => field?.toLowerCase() ?? "");
	for (const [index, field] of identity.entries()) {
		if (field === phrase) return index;
	}
	for (const [index, field] of identity.entries()) {
		if (field.startsWith(phrase)) return identity.length + index;
	}
	for (const [index, field] of identity.entries()) {
		if (field.includes(phrase)) return identity.length * 2 + index;
	}
	for (const [index, field] of supportingFields.entries()) {
		if (field?.toLowerCase().includes(phrase)) return identity.length * 3 + index;
	}

	const terms = searchTerms(query).map((term) => term.toLocaleLowerCase());
	const supporting = supportingFields.map((field) => field?.toLocaleLowerCase() ?? "");
	const fields = [...identity, ...supporting];
	if (!terms.every((term) => fields.some((field) => field.includes(term)))) return null;

	const supportingTermCount = terms.filter(
		(term) => !identity.some((field) => field.includes(term)),
	).length;
	return identity.length * 3 + supporting.length + supportingTermCount;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function searchExcerpt(text: string, query: string, limit = 240): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;

	const phrase = query.trim();
	const phraseMatch = phrase ? new RegExp(escapeRegExp(phrase), "iu").exec(compact) : null;
	const folded = compact.toLocaleLowerCase();
	const fallbackIndex = Math.min(
		...searchTerms(query)
			.map((term) => folded.indexOf(term.toLocaleLowerCase()))
			.filter((index) => index >= 0),
	);
	const matchIndex = phraseMatch?.index ?? (Number.isFinite(fallbackIndex) ? fallbackIndex : -1);
	if (matchIndex < 0) return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;

	let start = Math.max(0, matchIndex - Math.floor(limit / 3));
	const end = Math.min(compact.length, start + limit);
	start = Math.max(0, end - limit);
	return `${start > 0 ? "…" : ""}${compact.slice(start, end).trim()}${end < compact.length ? "…" : ""}`;
}

export function createSearchHighlighter(query: string) {
	const terms = searchTerms(query).sort((a, b) => b.length - a.length);
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
