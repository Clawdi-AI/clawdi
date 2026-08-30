import { splitSearchHighlight } from "@/lib/search-highlight";
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
					<mark
						key={`${index}:${part.text}`}
						className={cn(
							"bg-transparent font-semibold text-foreground underline decoration-primary/50 decoration-1 underline-offset-2",
							markClassName,
						)}
					>
						{part.text}
					</mark>
				) : (
					part.text
				),
			)}
		</span>
	);
}
