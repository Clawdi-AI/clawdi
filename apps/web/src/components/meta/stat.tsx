import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A single inline stat — icon + label, muted, baseline-aligned.
 *
 * Used everywhere a row needs to show a few quick metrics: session detail
 * header (43 messages · 99.4k tokens · 58m), session row in the list,
 * skill detail, agent detail. Keep the visual contract here so all of
 * those line up vertically and use the same icon size — that mismatch
 * was the user's "样式有点问题" complaint.
 */
export function Stat({
	icon: Icon,
	label,
	className,
}: {
	icon: LucideIcon;
	label: string;
	className?: string;
}) {
	return (
		<span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
			<Icon className="size-3.5 shrink-0" />
			<span className="truncate">{label}</span>
		</span>
	);
}
