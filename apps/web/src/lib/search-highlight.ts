export interface SearchHighlightPart {
	text: string;
	highlighted: boolean;
}

type SearchField = string | null | undefined;

const WEBSEARCH_TOKEN_PATTERN = /(-?)"([^"]+)"|(\S+)/gu;

export const SEARCH_MARK_CLASS =
	"box-decoration-clone rounded-sm bg-primary/20 px-px text-foreground";

export function searchTerms(query: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const match of query.matchAll(WEBSEARCH_TOKEN_PATTERN)) {
		const [, negated, quoted, unquoted] = match;
		const term = quoted !== undefined ? quoted.trim() : (unquoted ?? "");
		if (quoted !== undefined ? Boolean(negated) : term.startsWith("-") || /^or$/iu.test(term)) {
			continue;
		}
		if (!term) continue;
		const folded = term.toLocaleLowerCase();
		if (seen.has(folded)) continue;
		seen.add(folded);
		terms.push(term);
	}
	return terms;
}

export function searchHighlightTerms(query: string): string[] {
	const terms = searchTerms(query);
	const phrase = query.trim();
	const hasWebsearchOperator =
		phrase.includes('"') ||
		phrase.split(/\s+/u).some((term) => term.startsWith("-") || /^or$/iu.test(term));
	return phrase && terms.length > 1 && !hasWebsearchOperator ? [phrase, ...terms] : terms;
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

	const terms = searchTerms(query);
	const highlightTerms = searchHighlightTerms(query);
	const preferredPhrase = highlightTerms.length > terms.length ? highlightTerms[0] : undefined;
	const preferredIndex = preferredPhrase
		? (new RegExp(escapeRegExp(preferredPhrase), "iu").exec(compact)?.index ?? -1)
		: -1;
	const fallbackIndex = Math.min(
		...terms
			.map((term) => new RegExp(escapeRegExp(term), "iu").exec(compact)?.index ?? -1)
			.filter((index) => index >= 0),
	);
	const matchIndex =
		preferredIndex >= 0 ? preferredIndex : Number.isFinite(fallbackIndex) ? fallbackIndex : -1;
	if (matchIndex < 0) return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;

	let start = Math.max(0, matchIndex - Math.floor(limit / 3));
	const end = Math.min(compact.length, start + limit);
	start = Math.max(0, end - limit);
	return `${start > 0 ? "…" : ""}${compact.slice(start, end).trim()}${end < compact.length ? "…" : ""}`;
}

export function createSearchHighlighter(query: string) {
	const terms = searchHighlightTerms(query).sort((a, b) => b.length - a.length);
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
