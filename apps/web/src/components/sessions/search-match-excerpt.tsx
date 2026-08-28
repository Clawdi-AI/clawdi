import type { SessionListItem } from "@/lib/api-schemas";
import { cn } from "@/lib/utils";

type SessionSearchMatch = NonNullable<SessionListItem["search_match"]>;

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

function HighlightedExcerpt({ excerpt, query }: { excerpt: string; query: string }) {
	const terms = searchTerms(query);
	if (terms.length === 0) return excerpt;

	const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
	return excerpt.split(pattern).map((part, index) =>
		terms.some((term) => term.toLocaleLowerCase() === part.toLocaleLowerCase()) ? (
			<mark key={`${index}:${part}`} className="rounded-sm bg-primary/15 px-0.5 text-inherit">
				{part}
			</mark>
		) : (
			part
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
