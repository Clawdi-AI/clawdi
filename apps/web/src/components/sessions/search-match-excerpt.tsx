import type { SessionListItem } from "@/lib/api-schemas";
import { splitSearchHighlight } from "@/lib/search-highlight";
import { cn } from "@/lib/utils";

type SessionSearchMatch = NonNullable<SessionListItem["search_match"]>;

function HighlightedExcerpt({ excerpt, query }: { excerpt: string; query: string }) {
	return splitSearchHighlight(excerpt, query).map((part, index) =>
		part.highlighted ? (
			<mark key={`${index}:${part.text}`} className="rounded-sm bg-primary/15 px-0.5 text-inherit">
				{part.text}
			</mark>
		) : (
			part.text
		),
	);
}

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
		<span className={cn("truncate", className)} title={match.excerpt}>
			<span className="font-medium capitalize">{match.role}</span>
			{": "}
			<HighlightedExcerpt excerpt={match.excerpt} query={query} />
		</span>
	);
}
