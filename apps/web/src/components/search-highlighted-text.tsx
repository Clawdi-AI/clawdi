import { SEARCH_MARK_CLASS, splitSearchHighlight } from "@/lib/search-highlight";
import { cn } from "@/lib/utils";

export function SearchHighlightedText({
	text,
	query,
	className,
	markClassName,
}: {
	text: string;
	query: string;
	className?: string;
	markClassName?: string;
}) {
	return (
		<span className={className}>
			{splitSearchHighlight(text, query).map((part, index) =>
				part.highlighted ? (
					<mark key={`${index}:${part.text}`} className={cn(SEARCH_MARK_CLASS, markClassName)}>
						{part.text}
					</mark>
				) : (
					part.text
				),
			)}
		</span>
	);
}
