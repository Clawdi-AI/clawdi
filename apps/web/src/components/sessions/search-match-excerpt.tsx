import { SearchHighlightedText } from "@/components/search-highlighted-text";
import type { SessionListItem } from "@/lib/api-schemas";
import { cn } from "@/lib/utils";

type SessionSearchMatch = NonNullable<SessionListItem["search_match"]>;

export function SessionSearchMatchExcerpt({
	match,
	query,
	className,
}: {
	match: SessionSearchMatch;
	query: string;
	className?: string;
}) {
	return (
		<span className={cn(className)} title={match.excerpt}>
			<span className="font-medium capitalize">{match.role}</span>
			{": "}
			<SearchHighlightedText text={match.excerpt} query={query} />
		</span>
	);
}
