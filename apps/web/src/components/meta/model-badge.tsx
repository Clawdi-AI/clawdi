import { Badge } from "@/components/ui/badge";
import { formatModelLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A pill showing the model used for a session or message. Centralizes
 * the humanization (`claude-opus-4-7` → `Opus 4.7`) so list rows, detail
 * headers, message blocks, and the dashboard "this week" card all read
 * the same. Renders nothing if the id is missing — null-safe so callers
 * can drop it inline next to a `Stat` without an extra guard.
 */
export function ModelBadge({
	modelId,
	className,
}: {
	modelId: string | null | undefined;
	className?: string;
}) {
	const label = formatModelLabel(modelId);
	if (!label) return null;
	return (
		<Badge
			variant="outline"
			className={cn(
				// Match the visual weight of a `Stat` (text-xs, baseline-aligned).
				// `h-5` keeps the pill from making the row taller than the icons.
				"h-5 border-primary/30 px-1.5 font-mono text-[0.7rem] text-primary leading-none",
				className,
			)}
		>
			{label}
		</Badge>
	);
}
