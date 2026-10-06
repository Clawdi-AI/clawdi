import { SEARCH_MARK_CLASS, splitSearchHighlight } from "@clawdi/shared/api";
import { Text } from "@/components/ui/text";
import { webBoth } from "@/components/ui/web-layout";

/** Native text spans use the same literal search highlighter as Web. */
export function SearchHighlightedText({ text, query }: { text: string; query: string }) {
	return splitSearchHighlight(text, query).map((part, index) => (
		<Text
			key={`${index}:${part.text}`}
			className={part.highlighted ? webBoth(SEARCH_MARK_CLASS) : undefined}
		>
			{part.text}
		</Text>
	));
}
